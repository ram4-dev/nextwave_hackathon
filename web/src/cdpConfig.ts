export function cdpProviderConfig(projectId: string | undefined) {
  if (!projectId?.trim()) throw new Error('VITE_CDP_PROJECT_ID is required');
  return { projectId, ethereum: { createOnLogin: 'smart' as const }, authMethods: ['email'] as ['email'], appName: 'KYA' };
}
