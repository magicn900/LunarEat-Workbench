import { PanelTop } from 'lucide-react';
import { t } from './i18n';
import './workspace-identity.css';

export function WorkspaceIdentity({ projectName }: { projectName?: string }) {
    return <div className="workspace-identity">
        <span className="workspace-symbol" aria-hidden="true"><PanelTop size={19}/></span>
        <div className="workspace-identity-text">
            {projectName ? <><span className="workspace-caption">{t('工作台')}</span><strong className="workspace-project" title={projectName}>{projectName}</strong></> : <strong className="workspace-name">{t('工作台')}</strong>}
        </div>
    </div>;
}
