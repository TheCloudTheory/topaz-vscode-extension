import * as vscode from 'vscode';
import * as https from 'https';

interface HealthResponse {
    status: string;
    version: string;
    workingDirectory: string;
    runningMode: string;
    httpsConnectProxyAvailable: boolean;
    acrDockerExecutorAvailable: boolean;
    chaosEnabled: boolean;
}

export class TopazStatusProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private health: HealthResponse | null = null;
    private error: string | null = null;
    private getBaseUrl: () => string;

    constructor(getBaseUrl: () => string) {
        this.getBaseUrl = getBaseUrl;
    }

    setBaseUrl(url: string): void {
        this.getBaseUrl = () => url;
    }

    refresh(): void {
        this.fetchHealth().then(() => this._onDidChangeTreeData.fire());
    }

    private fetchHealth(): Promise<void> {
        const baseUrl = this.getBaseUrl();
        return new Promise(resolve => {
            const req = https.get(`${baseUrl}/health`, { rejectUnauthorized: false }, res => {
                let data = '';
                res.on('data', chunk => { data += chunk; });
                res.on('end', () => {
                    if (res.statusCode === 200) {
                        try {
                            this.health = JSON.parse(data) as HealthResponse;
                            this.error = null;
                        } catch {
                            this.health = null;
                            this.error = 'Invalid response from /health';
                        }
                    } else {
                        this.health = null;
                        this.error = `HTTP ${res.statusCode}`;
                    }
                    resolve();
                });
            });
            req.on('error', (err: Error) => { this.health = null; this.error = err.message; resolve(); });
            req.setTimeout(5000, () => { req.destroy(); this.health = null; this.error = 'timeout'; resolve(); });
        });
    }

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(): vscode.TreeItem[] {
        if (this.error) {
            const item = new vscode.TreeItem(`Unavailable: ${this.error}`);
            item.iconPath = new vscode.ThemeIcon('error');
            return [item];
        }
        if (!this.health) {
            const item = new vscode.TreeItem('Loading…');
            item.iconPath = new vscode.ThemeIcon('loading~spin');
            return [item];
        }
        const h = this.health;
        return [
            makeItem('Status', h.status, h.status === 'Healthy' ? 'pass' : 'error'),
            makeItem('Version', h.version, 'tag'),
            makeItem('Mode', h.runningMode, 'vm'),
            makeItem('HTTPS Proxy', h.httpsConnectProxyAvailable ? 'Available' : 'Not available', h.httpsConnectProxyAvailable ? 'pass' : 'circle-slash'),
            makeItem('ACR Executor', h.acrDockerExecutorAvailable ? 'Available' : 'Not available', h.acrDockerExecutorAvailable ? 'pass' : 'circle-slash'),
            makeItem('Chaos', h.chaosEnabled ? 'Enabled' : 'Disabled', h.chaosEnabled ? 'zap' : 'zap'),
        ];
    }
}

function makeItem(label: string, value: string, icon: string): vscode.TreeItem {
    const item = new vscode.TreeItem(`${label}: ${value}`);
    item.iconPath = new vscode.ThemeIcon(icon);
    return item;
}
