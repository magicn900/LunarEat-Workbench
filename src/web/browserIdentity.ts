let clientId = sessionStorage.getItem('workbench-client') || crypto.randomUUID();
let ready = false;
export const browserIdentity = new Promise<string>(resolve => {
    const accept = (id: string) => {
        clientId = id;
        sessionStorage.setItem('workbench-client', id);
        ready = true;
        resolve(id);
    };
    if (!navigator.locks) { accept(crypto.randomUUID()); return; }
    const claim = (id: string) => {
        void navigator.locks.request('workbench-tab:' + id, { ifAvailable: true }, async lock => {
            if (!lock) { claim(crypto.randomUUID()); return; }
            accept(id);
            await new Promise<void>(() => {});
        }).catch(() => accept(crypto.randomUUID()));
    };
    claim(clientId);
});
export function currentBrowserIdentity() { return ready ? clientId : null; }
