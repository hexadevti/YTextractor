/**
 * Audio device enumeration for the input/output selectors.
 *
 * Device labels are only populated after the user grants microphone
 * permission, so `requestPermission()` should be called before listing if you
 * want human-readable names (e.g. "M-Vave Tank-G").
 */

export interface DeviceOption {
  deviceId: string;
  label: string;
}

export interface DeviceLists {
  inputs: DeviceOption[];
  outputs: DeviceOption[];
}

/** Trigger the mic permission prompt so device labels become available. */
export async function requestPermission(): Promise<MediaStream | null> {
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    return null;
  }
}

export async function listDevices(): Promise<DeviceLists> {
  if (!navigator.mediaDevices?.enumerateDevices) return { inputs: [], outputs: [] };
  const devices = await navigator.mediaDevices.enumerateDevices();
  const inputs: DeviceOption[] = [];
  const outputs: DeviceOption[] = [];
  for (const d of devices) {
    if (d.kind === 'audioinput') {
      inputs.push({ deviceId: d.deviceId, label: d.label || `Microphone ${inputs.length + 1}` });
    } else if (d.kind === 'audiooutput') {
      outputs.push({ deviceId: d.deviceId, label: d.label || `Speaker ${outputs.length + 1}` });
    }
  }
  return { inputs, outputs };
}

/** Whether the browser supports choosing the AudioContext output device. */
export function supportsOutputSelection(): boolean {
  if (typeof AudioContext === 'undefined') return false; // SSR / unsupported
  return typeof (AudioContext.prototype as unknown as { setSinkId?: unknown }).setSinkId === 'function';
}
