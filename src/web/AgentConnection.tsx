import { Copy, ChevronDown, BookOpen } from 'lucide-react';
import { t } from './i18n.js';

export function AgentConnection({ projectName, copy }: { projectName: string; copy: (value: string) => Promise<void> }) {
    const origin = location.origin;
    const manifest = origin + '/api/agent/kit/manifest.json';
    const prompt = t('请帮我安装并配置当前工作台的协作 Skill。') + '\n' +
        t('工作站地址：') + origin + '\n' + t('预期项目：') + JSON.stringify(projectName) + '\n' +
        t('安装清单：') + manifest + '\n' +
        t('请从这个可信工作站读取清单，只下载清单列出的同源文件并校验 SHA-256，检查 Skill 和脚本后安装到当前客户端支持的位置。保留已有配置，不配置 MCP，不克隆整个项目。使用 Node.js 24 或更高版本。凭据通过环境变量私下提供，不要让我把密钥贴到聊天，也不要写入仓库或日志。完成后执行只读 connect，核对账号、项目和权限，不读取策划内容、不申请控制权、不修改或发布任何内容。如果客户端需要重新加载，请明确告诉我。');
    return <section className="agent-connection" aria-label={t('安装与连接')}>
        <div className="settings-section-heading"><h3>{t('先接入，再开始协作')}</h3></div>
        <p>{t('通过协作 Skill 连接 Agent，按账号权限读写当前项目。遇到冲突或控制权被收回时，Agent 会收到明确提示。')}</p>
        <button className="primary" onClick={() => void copy(prompt)}><Copy size={15}/>{t('复制给 Agent 的安装指令')}</button>
        <p className="agent-connection-hint">{t('安装指令不包含密钥。连接验证不会读取策划内容或锁定草稿。')}</p>
        <details className="settings-details"><summary>{t('手动安装与连接')}<ChevronDown size={15}/></summary>
            <dl><dt>{t('工作站地址')}</dt><dd><code>{origin}</code></dd><dt>{t('当前项目')}</dt><dd>{projectName}</dd></dl>
            <p>{t('先阅读安装说明并下载清单中的文件，再在 Skill 目录执行以下命令。将凭据私下设置到环境变量后运行 connect。')}</p>
            <a href="/api/agent/kit/references/connection.md" target="_blank" rel="noreferrer"><BookOpen size={15}/>{t('阅读安装说明')}</a>
            <pre>{'node scripts/agent.mjs configure --profile team --url ' + origin + ' --token-env WORKBENCH_TOKEN\nnode scripts/agent.mjs connect --profile team'}</pre>
            <button onClick={() => void copy(manifest)}><Copy size={15}/>{t('复制下载清单地址')}</button>
            <p>{t('远程部署必须使用 HTTPS。凭据仅代表当前账号被授予的项目权限；共享灵感池需要单独授权。')}</p>
        </details>
    </section>;
}
import './agent-connection.css';
