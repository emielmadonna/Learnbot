export interface DevelopmentVoiceSessionOwner {
  readonly tenantId: string;
  readonly actorId: string;
}

export function voiceSessionScopeMatches(
  owner: DevelopmentVoiceSessionOwner,
  requester: DevelopmentVoiceSessionOwner,
): boolean {
  return (
    owner.tenantId === requester.tenantId &&
    owner.actorId === requester.actorId
  );
}
