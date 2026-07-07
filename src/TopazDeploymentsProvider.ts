import * as vscode from 'vscode';
import * as https from 'https';
import { generateAdminToken } from './auth';

export type DeploymentNodeKind = 'scopeGroup' | 'deployment';

export interface DeploymentNode {
    kind: DeploymentNodeKind;
    id: string;
    label: string;
    description?: string;
    /** API path to fetch children (for scopeGroup nodes) */
    childrenPath?: string;
}

interface ArmDeployment {
    id: string;
    name: string;
    properties?: {
        provisioningState?: string;
        timestamp?: string;
    };
}

const STATE_ICON: Record<string, string> = {
    Succeeded: 'pass',
    Failed: 'error',
    Running: 'loading~spin',
    Canceled: 'circle-slash',
};

export class TopazDeploymentsProvider implements vscode.TreeDataProvider<DeploymentNode> {
    private _onDidChangeTreeData = new vscode.EventEmitter<DeploymentNode | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private available = false;
    private baseUrl: string;
    private treeView?: vscode.TreeView<DeploymentNode>;

    constructor(private getBaseUrl: () => string) {
        this.baseUrl = getBaseUrl();
    }

    setAvailable(v: boolean): void { this.available = v; }
    setBaseUrl(url: string): void { this.baseUrl = url; }
    setTreeView(view: vscode.TreeView<DeploymentNode>): void { this.treeView = view; }
    refresh(): void { this._onDidChangeTreeData.fire(); }

    getTreeItem(node: DeploymentNode): vscode.TreeItem {
        const item = new vscode.TreeItem(
            node.label,
            node.kind === 'scopeGroup'
                ? vscode.TreeItemCollapsibleState.Collapsed
                : vscode.TreeItemCollapsibleState.None
        );
        item.description = node.description;
        item.tooltip = node.id;
        if (node.kind === 'scopeGroup') {
            item.iconPath = new vscode.ThemeIcon('layers');
            item.contextValue = 'deploymentScope';
        } else {
            const state = node.description ?? '';
            item.iconPath = new vscode.ThemeIcon(STATE_ICON[state] ?? 'circle-outline');
            item.contextValue = 'deployment';
        }
        return item;
    }

    async getChildren(parent?: DeploymentNode): Promise<DeploymentNode[]> {
        if (!this.available) {
            if (this.treeView) { this.treeView.message = 'Topaz is not running or unreachable.'; }
            return [];
        }
        try {
            if (!parent) {
                return await this.getRootNodes();
            }
            if (parent.kind === 'scopeGroup' && parent.childrenPath) {
                return await this.getDeployments(parent.childrenPath);
            }
            return [];
        } catch {
            return [];
        }
    }

    private async getRootNodes(): Promise<DeploymentNode[]> {
        if (this.treeView) { this.treeView.message = undefined; }
        const nodes: DeploymentNode[] = [];

        // Tenant scope
        nodes.push({
            kind: 'scopeGroup',
            id: 'tenant',
            label: 'Tenant',
            description: 'tenant scope',
            childrenPath: '/providers/Microsoft.Resources/deployments?api-version=2021-04-01',
        });

        // Per-subscription scope nodes
        try {
            const res = await this.get<{ value: Array<{ subscriptionId: string; displayName: string }> }>(
                '/subscriptions?api-version=2022-12-01'
            );
            for (const sub of res.value ?? []) {
                nodes.push({
                    kind: 'scopeGroup',
                    id: `/subscriptions/${sub.subscriptionId}`,
                    label: sub.displayName,
                    description: 'subscription scope',
                    childrenPath: `/subscriptions/${sub.subscriptionId}/providers/Microsoft.Resources/deployments?api-version=2021-04-01`,
                });
                // Resource group scopes
                try {
                    const rgs = await this.get<{ value: Array<{ id: string; name: string }> }>(
                        `/subscriptions/${sub.subscriptionId}/resourcegroups?api-version=2021-04-01`
                    );
                    for (const rg of rgs.value ?? []) {
                        nodes.push({
                            kind: 'scopeGroup',
                            id: rg.id,
                            label: rg.name,
                            description: `resource group (${sub.displayName})`,
                            childrenPath: `${rg.id}/providers/Microsoft.Resources/deployments?api-version=2021-04-01`,
                        });
                    }
                } catch { /* skip RGs if unavailable */ }
            }
        } catch { /* subscriptions unavailable */ }

        return nodes;
    }

    private async getDeployments(path: string): Promise<DeploymentNode[]> {
        const res = await this.get<{ value: ArmDeployment[] }>(path);
        return (res.value ?? []).map(d => ({
            kind: 'deployment' as DeploymentNodeKind,
            id: d.id,
            label: d.name,
            description: d.properties?.provisioningState,
        }));
    }

    private get<T>(path: string): Promise<T> {
        const token = generateAdminToken(this.baseUrl);
        const url = new URL(`${this.baseUrl}${path}`);
        const options: https.RequestOptions = {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname + url.search,
            method: 'GET',
            rejectUnauthorized: false,
            headers: { Authorization: `Bearer ${token}` },
        };
        return new Promise((resolve, reject) => {
            const req = https.request(options, res => {
                let data = '';
                res.on('data', (chunk: Buffer) => { data += chunk; });
                res.on('end', () => {
                    if (res.statusCode && res.statusCode >= 400) {
                        reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { statusCode: res.statusCode }));
                        return;
                    }
                    try { resolve(JSON.parse(data) as T); }
                    catch (e) { reject(e); }
                });
            });
            req.on('error', reject);
            req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
            req.end();
        });
    }
}
