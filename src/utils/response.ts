export function createStandardResponse(success: boolean, data?: any, error?: string, requestId?: string) {
  return {
    success,
    data,
    error,
    timestamp: new Date().toISOString(),
    version: 'v3.0.0-enterprise-perfect',
    requestId
  };
}
