use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc,
};
use std::thread::{self, JoinHandle};
use tauri::ipc::{Channel, InvokeResponseBody};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoopbackMode {
    Include,
    Exclude,
}

pub struct AudioCaptureManager {
    stop_flag: Option<Arc<AtomicBool>>,
    worker: Option<JoinHandle<()>>,
}

impl AudioCaptureManager {
    pub fn new() -> Self {
        Self {
            stop_flag: None,
            worker: None,
        }
    }

    pub fn stop(&mut self) {
        if let Some(flag) = self.stop_flag.take() {
            flag.store(true, Ordering::SeqCst);
        }
        if let Some(handle) = self.worker.take() {
            let _ = handle.join();
        }
    }

    #[cfg(windows)]
    pub fn start(
        &mut self,
        pid: u32,
        mode: LoopbackMode,
        channel: Channel<InvokeResponseBody>,
    ) -> Result<(), String> {
        self.stop();

        let stop_flag = Arc::new(AtomicBool::new(false));
        let worker_stop = Arc::clone(&stop_flag);
        let (ready_tx, ready_rx) = mpsc::sync_channel::<Result<(), String>>(1);

        let handle = thread::Builder::new()
            .name(format!("wasapi-loopback-{pid}"))
            .spawn(move || {
                windows_impl::capture_thread(pid, mode, channel, worker_stop, ready_tx);
            })
            .map_err(|e| format!("Failed to spawn audio capture thread: {e}"))?;

        match ready_rx.recv() {
            Ok(Ok(())) => {
                self.stop_flag = Some(stop_flag);
                self.worker = Some(handle);
                Ok(())
            }
            Ok(Err(err)) => {
                let _ = handle.join();
                Err(err)
            }
            Err(_) => {
                let _ = handle.join();
                Err("Audio capture thread exited unexpectedly during initialization.".to_string())
            }
        }
    }

    #[cfg(not(windows))]
    pub fn start(
        &mut self,
        _pid: u32,
        _mode: LoopbackMode,
        _channel: Channel<InvokeResponseBody>,
    ) -> Result<(), String> {
        Err("Per-application WASAPI audio capture is only supported on Windows.".to_string())
    }
}

impl Drop for AudioCaptureManager {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(windows)]
mod windows_impl {
    use super::LoopbackMode;
    use std::mem::ManuallyDrop;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::SyncSender,
        Arc, Mutex,
    };
    use tauri::ipc::{Channel, InvokeResponseBody};
    use windows::core::{implement, Interface, Result as WinResult, HRESULT, PROPVARIANT};
    use windows::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0};
    use windows::Win32::Media::Audio::{
        ActivateAudioInterfaceAsync, IActivateAudioInterfaceAsyncOperation,
        IActivateAudioInterfaceCompletionHandler, IActivateAudioInterfaceCompletionHandler_Impl,
        IAudioCaptureClient, IAudioClient, AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM, AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
        AUDCLNT_STREAMFLAGS_LOOPBACK, AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
        AUDIOCLIENT_ACTIVATION_PARAMS, AUDIOCLIENT_ACTIVATION_PARAMS_0,
        AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK, AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS,
        PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE,
        PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE, VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
        WAVEFORMATEX,
    };
    use windows::Win32::System::Com::{
        CoInitializeEx, CoUninitialize, IAgileObject, IAgileObject_Impl, COINIT_MULTITHREADED,
    };
    use windows::Win32::System::Threading::{CreateEventW, SetEvent, WaitForSingleObject};

    const VT_BLOB: u16 = 65;

    const WAVE_FORMAT_IEEE_FLOAT: u16 = 0x0003;
    const SAMPLE_RATE: u32 = 48_000;
    const CHANNELS: u16 = 2;
    const BITS_PER_SAMPLE: u16 = 32;
    const BLOCK_ALIGN: u16 = CHANNELS * (BITS_PER_SAMPLE / 8); // 8 bytes per stereo frame
    const BUFFER_DURATION_100NS: i64 = 200_000; // 20 ms

    #[implement(IActivateAudioInterfaceCompletionHandler, IAgileObject)]
    struct ActivationHandler {
        event: HANDLE,
        result: Mutex<Option<WinResult<IAudioClient>>>,
    }

    // SAFETY: HANDLE is a kernel event handle safe to signal across threads.
    unsafe impl Send for ActivationHandler {}
    unsafe impl Sync for ActivationHandler {}

    impl IAgileObject_Impl for ActivationHandler_Impl {}

    impl IActivateAudioInterfaceCompletionHandler_Impl for ActivationHandler_Impl {
        fn ActivateCompleted(
            &self,
            activateoperation: Option<&IActivateAudioInterfaceAsyncOperation>,
        ) -> WinResult<()> {
            let outcome = unsafe {
                if let Some(op) = activateoperation {
                    let mut hr = HRESULT(0);
                    let mut iface = None;
                    match op.GetActivateResult(&mut hr, &mut iface) {
                        Ok(()) => {
                            if hr.is_err() {
                                Err(windows::core::Error::from(hr))
                            } else if let Some(unk) = iface {
                                unk.cast::<IAudioClient>()
                            } else {
                                Err(windows::core::Error::from_win32())
                            }
                        }
                        Err(e) => Err(e),
                    }
                } else {
                    Err(windows::core::Error::from_win32())
                }
            };

            if let Ok(mut slot) = self.result.lock() {
                *slot = Some(outcome);
            }
            unsafe {
                let _ = SetEvent(self.event);
            }
            Ok(())
        }
    }

    unsafe fn activate_process_loopback_client(
        pid: u32,
        mode: LoopbackMode,
    ) -> Result<IAudioClient, String> {
        let loopback_mode = match mode {
            LoopbackMode::Include => PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE,
            LoopbackMode::Exclude => PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE,
        };
        let mut activation_params = AUDIOCLIENT_ACTIVATION_PARAMS {
            ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
            Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
                ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                    TargetProcessId: pid,
                    ProcessLoopbackMode: loopback_mode,
                },
            },
        };

        // Wrap in ManuallyDrop so Drop never calls PropVariantClear on stack memory.
        let mut raw_prop: windows_core::imp::PROPVARIANT = std::mem::zeroed();
        raw_prop.Anonymous.Anonymous.vt = VT_BLOB;
        raw_prop.Anonymous.Anonymous.Anonymous.blob = windows_core::imp::BLOB {
            cbSize: std::mem::size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32,
            pBlobData: (&mut activation_params as *mut AUDIOCLIENT_ACTIVATION_PARAMS) as *mut u8,
        };
        let prop_variant = ManuallyDrop::new(PROPVARIANT::from_raw(raw_prop));

        let ready_event = CreateEventW(None, false, false, None)
            .map_err(|e| format!("CreateEventW failed: {e}"))?;

        let handler_impl = ActivationHandler {
            event: ready_event,
            result: Mutex::new(None),
        };
        let handler: IActivateAudioInterfaceCompletionHandler = handler_impl.into();

        let _operation = ActivateAudioInterfaceAsync(
            VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
            &IAudioClient::IID,
            Some(&*prop_variant as *const PROPVARIANT),
            &handler,
        )
        .map_err(|e| {
            let _ = CloseHandle(ready_event);
            format!(
                "WASAPI Process Loopback activation failed (requires Windows 10 20348+ / Windows 11): {e}"
            )
        })?;

        let wait_res = WaitForSingleObject(ready_event, 5000);
        let _ = CloseHandle(ready_event);

        if wait_res != WAIT_OBJECT_0 {
            return Err("Timed out waiting for WASAPI Process Loopback activation.".to_string());
        }

        let handler_ref: &ActivationHandler =
            windows::core::AsImpl::as_impl(&handler);
        let client_res = handler_ref
            .result
            .lock()
            .map_err(|_| "Activation result mutex poisoned".to_string())?
            .take()
            .ok_or_else(|| "WASAPI activation completed without result".to_string())?;

        client_res.map_err(|e| format!("WASAPI Process Loopback returned error: {e}"))
    }

    pub fn capture_thread(
        pid: u32,
        mode: LoopbackMode,
        channel: Channel<InvokeResponseBody>,
        stop_flag: Arc<AtomicBool>,
        ready_tx: SyncSender<Result<(), String>>,
    ) {
        unsafe {
            let com_hr = CoInitializeEx(None, COINIT_MULTITHREADED);
            if com_hr.is_err() {
                let _ = ready_tx.send(Err(format!("CoInitializeEx failed: {com_hr:?}")));
                return;
            }

            let init_res = (|| -> Result<(IAudioClient, IAudioCaptureClient, HANDLE), String> {
                let audio_client = activate_process_loopback_client(pid, mode)?;

                let format = WAVEFORMATEX {
                    wFormatTag: WAVE_FORMAT_IEEE_FLOAT,
                    nChannels: CHANNELS,
                    nSamplesPerSec: SAMPLE_RATE,
                    nAvgBytesPerSec: SAMPLE_RATE * (BLOCK_ALIGN as u32),
                    nBlockAlign: BLOCK_ALIGN,
                    wBitsPerSample: BITS_PER_SAMPLE,
                    cbSize: 0,
                };

                let stream_flags = AUDCLNT_STREAMFLAGS_LOOPBACK
                    | AUDCLNT_STREAMFLAGS_EVENTCALLBACK
                    | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
                    | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;

                audio_client
                    .Initialize(
                        AUDCLNT_SHAREMODE_SHARED,
                        stream_flags,
                        BUFFER_DURATION_100NS,
                        0,
                        &format,
                        None,
                    )
                    .map_err(|e| format!("IAudioClient::Initialize failed: {e}"))?;

                let sample_event = CreateEventW(None, false, false, None)
                    .map_err(|e| format!("CreateEventW for audio callback failed: {e}"))?;

                if let Err(e) = audio_client.SetEventHandle(sample_event) {
                    let _ = CloseHandle(sample_event);
                    return Err(format!("IAudioClient::SetEventHandle failed: {e}"));
                }

                let capture_client: IAudioCaptureClient = match audio_client.GetService() {
                    Ok(c) => c,
                    Err(e) => {
                        let _ = CloseHandle(sample_event);
                        return Err(format!("IAudioClient::GetService failed: {e}"));
                    }
                };

                if let Err(e) = audio_client.Start() {
                    let _ = CloseHandle(sample_event);
                    return Err(format!("IAudioClient::Start failed: {e}"));
                }

                Ok((audio_client, capture_client, sample_event))
            })();

            let (audio_client, capture_client, sample_event) = match init_res {
                Ok(tuple) => {
                    let _ = ready_tx.send(Ok(()));
                    tuple
                }
                Err(err) => {
                    let _ = ready_tx.send(Err(err));
                    CoUninitialize();
                    return;
                }
            };

            while !stop_flag.load(Ordering::Relaxed) {
                let _ = WaitForSingleObject(sample_event, 100);
                if stop_flag.load(Ordering::Relaxed) {
                    break;
                }

                loop {
                    let next_packet = match capture_client.GetNextPacketSize() {
                        Ok(n) => n,
                        Err(_) => break,
                    };
                    if next_packet == 0 {
                        break;
                    }

                    let mut data_ptr: *mut u8 = std::ptr::null_mut();
                    let mut num_frames: u32 = 0;
                    let mut flags: u32 = 0;

                    if capture_client
                        .GetBuffer(&mut data_ptr, &mut num_frames, &mut flags, None, None)
                        .is_err()
                    {
                        break;
                    }

                    if num_frames > 0 && !data_ptr.is_null() {
                        let is_silent = (flags & (AUDCLNT_BUFFERFLAGS_SILENT.0 as u32)) != 0;
                        if !is_silent {
                            let byte_len = (num_frames as usize) * (BLOCK_ALIGN as usize);
                            let bytes = std::slice::from_raw_parts(data_ptr, byte_len).to_vec();
                            if channel.send(InvokeResponseBody::Raw(bytes)).is_err() {
                                let _ = capture_client.ReleaseBuffer(num_frames);
                                stop_flag.store(true, Ordering::Relaxed);
                                break;
                            }
                        }
                    }

                    if capture_client.ReleaseBuffer(num_frames).is_err() {
                        break;
                    }
                }
            }

            let _ = audio_client.Stop();
            let _ = CloseHandle(sample_event);
            CoUninitialize();
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use windows::Win32::System::Threading::GetCurrentProcessId;

        #[test]
        fn wasapi_process_loopback_initializes_on_windows() {
            unsafe {
                let hr = CoInitializeEx(None, COINIT_MULTITHREADED);
                assert!(hr.is_ok(), "CoInitializeEx failed: {hr:?}");

                let pid = GetCurrentProcessId();
                for mode in [LoopbackMode::Include, LoopbackMode::Exclude] {
                    let client = activate_process_loopback_client(pid, mode)
                        .expect("activate_process_loopback_client should succeed");

                    let format = WAVEFORMATEX {
                        wFormatTag: WAVE_FORMAT_IEEE_FLOAT,
                        nChannels: CHANNELS,
                        nSamplesPerSec: SAMPLE_RATE,
                        nAvgBytesPerSec: SAMPLE_RATE * (BLOCK_ALIGN as u32),
                        nBlockAlign: BLOCK_ALIGN,
                        wBitsPerSample: BITS_PER_SAMPLE,
                        cbSize: 0,
                    };

                    let stream_flags = AUDCLNT_STREAMFLAGS_LOOPBACK
                        | AUDCLNT_STREAMFLAGS_EVENTCALLBACK
                        | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
                        | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;

                    let init_res = client.Initialize(
                        AUDCLNT_SHAREMODE_SHARED,
                        stream_flags,
                        BUFFER_DURATION_100NS,
                        0,
                        &format,
                        None,
                    );
                    assert!(init_res.is_ok(), "IAudioClient::Initialize failed: {init_res:?}");

                    let ev = CreateEventW(None, false, false, None).unwrap();
                    client.SetEventHandle(ev).expect("SetEventHandle failed");
                    let _cap: IAudioCaptureClient = client.GetService().expect("GetService failed");
                    client.Start().expect("Start failed");
                    client.Stop().expect("Stop failed");
                    let _ = CloseHandle(ev);
                }
                CoUninitialize();
            }
        }
    }
}
