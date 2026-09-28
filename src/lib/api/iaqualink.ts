import { apiClient } from '@/lib/apiClient';

type IaqualinkProxyResponse = {
  success: boolean;
  error?: string;
  devices?: unknown[] | { devices?: unknown[] };
  status?: unknown;
  [key: string]: unknown;
};

async function callIaqualinkProxy(body: Record<string, unknown>): Promise<IaqualinkProxyResponse> {
  return apiClient.invokeFn<IaqualinkProxyResponse>('iaqualink-proxy', body);
}

export async function listDevices() {
  return callIaqualinkProxy({ action: 'list-devices' });
}

export async function getDeviceStatus(serialNumber: string) {
  return callIaqualinkProxy({ action: 'device-status', serial_number: serialNumber });
}

export async function setAux(serialNumber: string, auxId: string, value: string) {
  return callIaqualinkProxy({ action: 'set-aux', serial_number: serialNumber, aux_id: auxId, value });
}

export async function setTemperature(serialNumber: string, tempType: string, value: number) {
  return callIaqualinkProxy({ action: 'set-temperature', serial_number: serialNumber, temp_type: tempType, value });
}
