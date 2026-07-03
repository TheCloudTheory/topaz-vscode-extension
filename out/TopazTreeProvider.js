"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.TopazTreeProvider = void 0;
const vscode = __importStar(require("vscode"));
const https = __importStar(require("https"));
const ICONS = {
    managementGroup: 'organization',
    subscription: 'layers',
    resourceGroup: 'folder',
    resource: 'symbol-misc',
};
class TopazTreeProvider {
    constructor(getBaseUrl) {
        this.getBaseUrl = getBaseUrl;
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
        this.available = false;
        this.baseUrl = getBaseUrl();
    }
    setAvailable(v) { this.available = v; }
    setBaseUrl(url) { this.baseUrl = url; }
    refresh() { this._onDidChangeTreeData.fire(); }
    getTreeItem(node) {
        const item = new vscode.TreeItem(node.label, node.kind === 'resource'
            ? vscode.TreeItemCollapsibleState.None
            : vscode.TreeItemCollapsibleState.Collapsed);
        item.description = node.description;
        item.iconPath = new vscode.ThemeIcon(ICONS[node.kind]);
        item.contextValue = node.kind;
        item.tooltip = node.id;
        return item;
    }
    async getChildren(parent) {
        if (!this.available) {
            return [];
        }
        try {
            if (!parent) {
                return await this.getManagementGroups();
            }
            switch (parent.kind) {
                case 'managementGroup': return await this.getManagementGroupChildren(parent.id);
                case 'subscription': return await this.getResourceGroups(parent.id);
                case 'resourceGroup': return await this.getResources(parent.id);
                default: return [];
            }
        }
        catch {
            return [];
        }
    }
    // ── API helpers ──────────────────────────────────────────────────────────
    get(path) {
        return new Promise((resolve, reject) => {
            const req = https.get(`${this.baseUrl}${path}`, { rejectUnauthorized: false }, res => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(data));
                    }
                    catch (e) {
                        reject(e);
                    }
                });
            });
            req.on('error', reject);
            req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
        });
    }
    async getManagementGroups() {
        const res = await this.get('/providers/Microsoft.Management/managementGroups?api-version=2020-05-01');
        return (res.value ?? []).map(g => ({
            kind: 'managementGroup',
            id: g.id,
            label: g.properties?.displayName ?? g.name,
        }));
    }
    async getManagementGroupChildren(mgId) {
        // mgId is the full path like /providers/Microsoft.Management/managementGroups/{name}
        const name = mgId.split('/').pop();
        const res = await this.get(`/providers/Microsoft.Management/managementGroups/${name}?api-version=2020-05-01&$expand=children`);
        const children = res.properties?.children ?? [];
        return children.map(c => {
            const isSub = c.type === '/subscriptions';
            return {
                kind: isSub ? 'subscription' : 'managementGroup',
                id: c.id,
                label: c.displayName ?? c.name,
                description: isSub ? 'subscription' : undefined,
            };
        });
    }
    async getResourceGroups(subscriptionId) {
        // subscriptionId may be full path /subscriptions/{id} or just the guid
        const id = subscriptionId.replace(/^\/subscriptions\//, '');
        const res = await this.get(`/subscriptions/${id}/resourcegroups?api-version=2021-04-01`);
        return (res.value ?? []).map(rg => ({
            kind: 'resourceGroup',
            id: rg.id,
            label: rg.name,
            description: rg.location,
        }));
    }
    async getResources(rgId) {
        // rgId: /subscriptions/{sub}/resourceGroups/{rg}
        const res = await this.get(`${rgId}/resources?api-version=2021-04-01`);
        return (res.value ?? []).map(r => ({
            kind: 'resource',
            id: r.id,
            label: r.name,
            description: r.type.split('/').slice(1).join('/'),
        }));
    }
}
exports.TopazTreeProvider = TopazTreeProvider;
//# sourceMappingURL=TopazTreeProvider.js.map