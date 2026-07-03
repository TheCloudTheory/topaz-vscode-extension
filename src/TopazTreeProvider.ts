import * as vscode from 'vscode';
import * as https from 'https';

export type NodeKind = 'managementGroup' | 'subscription' | 'resourceGroup' | 'resource';

export interface TopazNode {
    kind: NodeKind;
    id: string;
    label: string;
    description?: string;
}

const ICONS: Record<NodeKind, string> = {
    managementGroup: 'organization',
    subscription: 'layers',
    resourceGroup: 'folder',
    resource: 'symbol-misc',
};

export class TopazTreeProvider implements vscode.TreeDataProvider<TopazNode> {
    private _onDidChangeTreeData = new vscode.EventEmitter<TopazNode | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private available = false;
    private baseUrl: string;

    constructor(private getBaseUrl: () => string) {
        this.baseUrl = getBaseUrl();
    }

    setAvailable(v: boolean): void { this.available = v; }
    setBaseUrl(url: string): void { this.baseUrl = url; }
    refresh(): void { this._onDidChangeTreeData.fire(); }

    getTreeItem(node: TopazNode): vscode.TreeItem {
        const item = new vscode.TreeItem(
            node.label,
            node.kind === 'resource'
                ? vscode.TreeItemCollapsibleState.None
                : vscode.TreeItemCollapsibleState.Collapsed
        );
        item.description = node.description;
        item.iconPath = new vscode.ThemeIcon(ICONS[node.kind]);
        item.contextValue = node.kind;
        item.tooltip = node.id;
        return item;
    }

    async getChildren(parent?: TopazNode): Promise<TopazNode[]> {
        if (!this.available) { return []; }

        try {
            if (!parent) {
                return await this.getManagementGroups();
            }
            switch (parent.kind) {
                case 'managementGroup': return await this.getManagementGroupChildren(parent.id);
                case 'subscription':   return await this.getResourceGroups(parent.id);
                case 'resourceGroup':  return await this.getResources(parent.id);
                default: return [];
            }
        } catch {
            return [];
        }
    }

    // ── API helpers ──────────────────────────────────────────────────────────

    private get<T>(path: string): Promise<T> {
        return new Promise((resolve, reject) => {
            const req = https.get(`${this.baseUrl}${path}`, { rejectUnauthorized: false }, res => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try { resolve(JSON.parse(data) as T); }
                    catch (e) { reject(e); }
                });
            });
            req.on('error', reject);
            req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
        });
    }

    private async getManagementGroups(): Promise<TopazNode[]> {
        const res = await this.get<{ value: Array<{ id: string; name: string; properties?: { displayName?: string } }> }>(
            '/providers/Microsoft.Management/managementGroups?api-version=2020-05-01'
        );
        return (res.value ?? []).map(g => ({
            kind: 'managementGroup',
            id: g.id,
            label: g.properties?.displayName ?? g.name,
        }));
    }

    private async getManagementGroupChildren(mgId: string): Promise<TopazNode[]> {
        // mgId is the full path like /providers/Microsoft.Management/managementGroups/{name}
        const name = mgId.split('/').pop()!;
        const res = await this.get<{
            properties?: {
                children?: Array<{ id: string; name: string; type: string; displayName?: string }>;
            };
        }>(`/providers/Microsoft.Management/managementGroups/${name}?api-version=2020-05-01&$expand=children`);

        const children = res.properties?.children ?? [];
        return children.map(c => {
            const isSub = c.type === '/subscriptions';
            return {
                kind: isSub ? 'subscription' : 'managementGroup',
                id: c.id,
                label: c.displayName ?? c.name,
                description: isSub ? 'subscription' : undefined,
            } as TopazNode;
        });
    }

    private async getResourceGroups(subscriptionId: string): Promise<TopazNode[]> {
        // subscriptionId may be full path /subscriptions/{id} or just the guid
        const id = subscriptionId.replace(/^\/subscriptions\//, '');
        const res = await this.get<{ value: Array<{ id: string; name: string; location: string }> }>(
            `/subscriptions/${id}/resourcegroups?api-version=2021-04-01`
        );
        return (res.value ?? []).map(rg => ({
            kind: 'resourceGroup',
            id: rg.id,
            label: rg.name,
            description: rg.location,
        }));
    }

    private async getResources(rgId: string): Promise<TopazNode[]> {
        // rgId: /subscriptions/{sub}/resourceGroups/{rg}
        const res = await this.get<{ value: Array<{ id: string; name: string; type: string }> }>(
            `${rgId}/resources?api-version=2021-04-01`
        );
        return (res.value ?? []).map(r => ({
            kind: 'resource',
            id: r.id,
            label: r.name,
            description: r.type.split('/').slice(1).join('/'),
        }));
    }
}
