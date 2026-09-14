export function documentDelta<Step>(version: number, remote: { version: number; steps: Step[]; clientIds: string[] }) {
    if (remote.version <= version) return { kind: 'stale' as const };
    const count = remote.version - version;
    if (remote.steps.length < count || remote.steps.length !== remote.clientIds.length) return { kind: 'gap' as const };
    return { kind: 'steps' as const, steps: remote.steps.slice(-count), clientIds: remote.clientIds.slice(-count) };
}
