export function generateRequestId(): string {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

export function logger(level: 'info' | 'warn' | 'error', message: string, data?: any, requestId?: string) {
  console.log(JSON.stringify({ 
    timestamp: new Date().toISOString(), 
    level, 
    message, 
    requestId, 
    ...data 
  }));
}
