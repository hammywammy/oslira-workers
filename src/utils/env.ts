export function getEnvironment(env: any): 'production' | 'staging' {
  return (env.APP_ENV || 'production') as 'production' | 'staging';
}

export function isProduction(env: any): boolean {
  return getEnvironment(env) === 'production';
}

export function isStaging(env: any): boolean {
  return getEnvironment(env) === 'staging';
}
