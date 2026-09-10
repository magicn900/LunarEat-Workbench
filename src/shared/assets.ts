export const imageUploadLimit = 10 * 1024 * 1024;
export const imagePixelLimit = 40_000_000;
export const imageTypes = ['image/png', 'image/jpeg', 'image/webp'];
export function assetURL(projectId: string, id: string) { return '/api/projects/' + encodeURIComponent(projectId) + '/assets/' + id; }
export function assetReference(source: string): { projectId: string; id: string } | null {
    try {
        const path = new URL(source, 'https://workbench.invalid').pathname;
        const match = new RegExp('^/api/projects/([^/]+)/assets/([a-f0-9-]{36})$').exec(path);
        return match ? { projectId: decodeURIComponent(match[1]), id: match[2] } : null;
    } catch { return null; }
}
