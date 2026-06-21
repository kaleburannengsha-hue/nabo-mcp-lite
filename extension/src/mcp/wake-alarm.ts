interface AlarmApi {
  create(name: string, alarmInfo: { periodInMinutes: number }): void | Promise<void>;
  onAlarm: {
    addListener(callback: (alarm: { name: string }) => void): void;
  };
}

interface WakeAlarmOptions {
  alarms: AlarmApi;
  ensureConnected(): void;
}

export const MCP_WAKE_ALARM = 'nanobrowser-mcp-keepalive';

export function installMcpWakeAlarm({ alarms, ensureConnected }: WakeAlarmOptions) {
  void alarms.create(MCP_WAKE_ALARM, { periodInMinutes: 0.5 });
  alarms.onAlarm.addListener(alarm => {
    if (alarm.name === MCP_WAKE_ALARM) ensureConnected();
  });
}
