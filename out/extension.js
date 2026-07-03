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
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const https = __importStar(require("https"));
const TopazTreeProvider_1 = require("./TopazTreeProvider");
const DOCS_URL = 'https://topaz.thecloudtheory.com/docs/intro/';
function getBaseUrl() {
    return vscode.workspace.getConfiguration('topaz').get('baseUrl', 'https://topaz.local.dev:8899');
}
function checkHealth(baseUrl) {
    return new Promise(resolve => {
        const req = https.get(`${baseUrl}/health`, { rejectUnauthorized: false }, res => {
            resolve(res.statusCode === 200);
            res.resume();
        });
        req.on('error', () => resolve(false));
        req.setTimeout(5000, () => { req.destroy(); resolve(false); });
    });
}
async function activate(context) {
    const provider = new TopazTreeProvider_1.TopazTreeProvider(getBaseUrl);
    context.subscriptions.push(vscode.window.registerTreeDataProvider('topazResources', provider), vscode.commands.registerCommand('topaz.refresh', async () => {
        provider.setBaseUrl(getBaseUrl());
        await runHealthCheck(provider);
        provider.refresh();
    }), vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('topaz.baseUrl')) {
            provider.setBaseUrl(getBaseUrl());
            provider.refresh();
        }
    }));
    await runHealthCheck(provider);
}
async function runHealthCheck(provider) {
    const baseUrl = getBaseUrl();
    const healthy = await checkHealth(baseUrl);
    if (!healthy) {
        const choice = await vscode.window.showErrorMessage(`Topaz is not running at ${baseUrl}. Make sure it is started before using this extension.`, 'Open Docs');
        if (choice === 'Open Docs') {
            vscode.env.openExternal(vscode.Uri.parse(DOCS_URL));
        }
        provider.setAvailable(false);
    }
    else {
        provider.setAvailable(true);
    }
    provider.refresh();
}
function deactivate() { }
//# sourceMappingURL=extension.js.map