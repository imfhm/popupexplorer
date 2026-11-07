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
let popupActions;
function activate(context) {
    context.subscriptions.push(vscode.commands.registerCommand('popupFileExplorer.open', () => openExplorer()), vscode.commands.registerCommand('popupFileExplorer.focusUp', () => popupActions?.moveActiveItem(-1)), vscode.commands.registerCommand('popupFileExplorer.focusDown', () => popupActions?.moveActiveItem(1)), vscode.commands.registerCommand('popupFileExplorer.toggleExpand', () => popupActions?.toggleActiveFolder()), vscode.commands.registerCommand('popupFileExplorer.deleteEntry', () => popupActions?.deleteActiveEntry()), vscode.commands.registerCommand('popupFileExplorer.renameEntry', () => popupActions?.renameActiveEntry()), vscode.commands.registerCommand('popupFileExplorer.collapseAll', () => popupActions?.collapseAllFolders()), vscode.commands.registerCommand('popupFileExplorer.createFile', () => popupActions?.startCreateEntry('file')), vscode.commands.registerCommand('popupFileExplorer.createFolder', () => popupActions?.startCreateEntry('directory')), vscode.commands.registerCommand('popupFileExplorer.focusTree', () => popupActions?.setNavigationMode(true)), vscode.commands.registerCommand('popupFileExplorer.focusSearch', () => popupActions?.setNavigationMode(false)), vscode.commands.registerCommand('popupFileExplorer.toggleNavigationMode', () => popupActions?.toggleNavigationMode()));
}
function openExplorer(initialSelectionUri) {
    const quickPick = vscode.window.createQuickPick();
    const roots = (vscode.workspace.workspaceFolders ?? []).map((folder) => ({
        uri: folder.uri,
        name: folder.name,
        kind: 'directory',
        loaded: false,
        expanded: true,
    }));
    let visibleEntries = roots;
    let searchRequest = 0;
    let searchMode = false;
    let treeNavigationMode = true;
    let lastActiveUri;
    quickPick.title = 'Popup File Explorer';
    quickPick.placeholder = roots.length
        ? 'Search workspace files or expand folders'
        : 'Open a workspace folder to browse files';
    quickPick.matchOnDescription = true;
    quickPick.ignoreFocusOut = false;
    const showError = (error) => {
        const detail = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(`Popup File Explorer: ${detail}`);
    };
    const setContext = (key, value) => {
        void vscode.commands.executeCommand('setContext', key, value).then(undefined, showError);
    };
    const setNavigationMode = (enabled) => {
        const changed = treeNavigationMode !== enabled;
        if (changed && !enabled) {
            const activeItem = quickPick.activeItems[0];
            if (activeItem) {
                lastActiveUri = activeItem.uri;
            }
            quickPick.activeItems = [];
        }
        treeNavigationMode = enabled;
        setContext('popupFileExplorerTreeFocus', enabled);
        if (changed && enabled) {
            const activeItem = quickPick.items.find((item) => item.uri.toString() === lastActiveUri?.toString()) ?? quickPick.items[0];
            quickPick.activeItems = activeItem ? [activeItem] : [];
        }
        quickPick.prompt = enabled
            ? 'EXPLORER | W/S: move  Space: expand/collapse  D: remove  N/M: create file/folder  Tab: search'
            : 'SEARCH | Type to filter files  Tab: Explorer';
    };
    const toggleNavigationMode = () => {
        setNavigationMode(!treeNavigationMode);
    };
    quickPick.onDidChangeActive((items) => {
        if (treeNavigationMode && items[0]) {
            lastActiveUri = items[0].uri;
        }
        else if (!treeNavigationMode && items.length > 0) {
            quickPick.activeItems = [];
        }
    });
    const readChildren = async (entry) => {
        if (entry.loaded) {
            return entry.children ?? [];
        }
        const entries = await vscode.workspace.fs.readDirectory(entry.uri);
        entry.children = entries
            .map(([name, type]) => ({
            uri: vscode.Uri.joinPath(entry.uri, name),
            name,
            kind: (type & vscode.FileType.Directory) !== 0 ? 'directory' : 'file',
            loaded: false,
            expanded: false,
        }))
            .sort((left, right) => {
            if (left.kind !== right.kind) {
                return left.kind === 'directory' ? -1 : 1;
            }
            return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' });
        });
        entry.loaded = true;
        return entry.children;
    };
    const revealEntry = async (uri) => {
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
        if (!workspaceFolder) {
            return undefined;
        }
        let entry = roots.find((root) => root.uri.toString() === workspaceFolder.uri.toString());
        if (!entry) {
            return undefined;
        }
        entry.expanded = true;
        const relativePath = vscode.workspace.asRelativePath(uri, false);
        const segments = relativePath.split(/[\\/]/).filter(Boolean);
        for (const [index, segment] of segments.entries()) {
            const children = await readChildren(entry);
            const child = children.find((candidate) => candidate.name === segment);
            if (!child) {
                return undefined;
            }
            if (index < segments.length - 1) {
                if (child.kind !== 'directory') {
                    return undefined;
                }
                child.expanded = true;
                entry = child;
            }
            else {
                return child;
            }
        }
        return entry;
    };
    const flattenTree = async (entries, depth, request) => {
        const items = [];
        for (const entry of entries) {
            if (request !== searchRequest) {
                return [];
            }
            const children = entry.kind === 'directory' && entry.expanded
                ? await readChildren(entry)
                : [];
            if (request !== searchRequest) {
                return [];
            }
            items.push({
                label: searchMode
                    ? `${'\u00a0\u00a0'.repeat(depth)}${entry.kind === 'directory' ? (entry.expanded ? '$(chevron-down)' : '$(chevron-right)') : ''} `
                    : `${'\u00a0\u00a0'.repeat(depth)}${entry.kind === 'directory' ? (entry.expanded ? '$(chevron-down)' : '$(chevron-right)') : ''} ${entry.name}`,
                kind: vscode.QuickPickItemKind.Default,
                alwaysShow: searchMode,
                description: searchMode ? entry.name : '\u200b',
                iconPath: entry.kind === 'directory' ? vscode.ThemeIcon.Folder : vscode.ThemeIcon.File,
                resourceUri: entry.uri,
                uri: entry.uri,
                entryKind: entry.kind,
            });
            if (entry.kind === 'directory' && entry.expanded) {
                items.push(...await flattenTree(children, depth + 1, request));
            }
        }
        return items;
    };
    const setTreeItems = async (request, activeUri) => {
        searchMode = false;
        quickPick.matchOnDescription = true;
        quickPick.busy = true;
        visibleEntries = roots;
        await renderVisibleTree(request, activeUri);
    };
    const renderVisibleTree = async (request, activeUri) => {
        quickPick.busy = true;
        const items = await flattenTree(visibleEntries, 0, request);
        if (request === searchRequest) {
            quickPick.items = items;
            if (treeNavigationMode && activeUri) {
                const activeItem = items.find((item) => item.uri.toString() === activeUri.toString());
                if (activeItem) {
                    quickPick.activeItems = [activeItem];
                }
            }
            quickPick.busy = false;
        }
    };
    const getActiveItem = () => quickPick.activeItems[0] ?? quickPick.items[0];
    const toggleFolder = (uri) => {
        const entry = findEntry(visibleEntries, uri);
        if (!entry || entry.kind !== 'directory') {
            return;
        }
        entry.expanded = !entry.expanded;
        const request = ++searchRequest;
        void renderVisibleTree(request, uri).catch(showError);
    };
    const collapseAllFolders = () => {
        const collapse = (entries) => {
            for (const entry of entries) {
                if (entry.kind === 'directory') {
                    entry.expanded = false;
                }
                if (entry.children) {
                    collapse(entry.children);
                }
            }
        };
        collapse(visibleEntries);
        const request = ++searchRequest;
        void renderVisibleTree(request).catch(showError);
    };
    const deleteActiveEntry = () => {
        const activeItem = getActiveItem();
        if (!activeItem) {
            return;
        }
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(activeItem.uri);
        if (!workspaceFolder) {
            void vscode.window.showErrorMessage('Popup File Explorer: Only workspace files and folders can be removed.');
            return;
        }
        if (activeItem.uri.toString() === workspaceFolder.uri.toString()) {
            void vscode.window.showErrorMessage('Popup File Explorer: A workspace root cannot be removed from this view.');
            return;
        }
        const entryKind = activeItem.entryKind === 'directory' ? 'folder' : 'file';
        const parentUri = vscode.Uri.joinPath(activeItem.uri, '..');
        const confirmationPromise = vscode.window.showInputBox({
            title: 'Confirm Removal',
            prompt: `Do you really want to remove this ${entryKind}? Type YES to confirm.`,
            placeHolder: 'Type YES to confirm',
            ignoreFocusOut: true,
            validateInput: (value) => value === 'YES' ? undefined : 'Type YES to confirm removal.',
        });
        void confirmationPromise.then(async (confirmation) => {
            if (confirmation !== 'YES') {
                openExplorer(activeItem.uri);
                return;
            }
            try {
                await vscode.workspace.fs.delete(activeItem.uri, {
                    recursive: activeItem.entryKind === 'directory',
                    useTrash: true,
                });
                openExplorer(parentUri);
            }
            catch (error) {
                showError(error);
                openExplorer(activeItem.uri);
            }
        }, (error) => {
            showError(error);
            openExplorer(activeItem.uri);
        });
    };
    const renameActiveEntry = () => {
        const activeItem = getActiveItem();
        if (!activeItem) {
            return;
        }
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(activeItem.uri);
        if (!workspaceFolder) {
            void vscode.window.showErrorMessage('Popup File Explorer: Only workspace files and folders can be renamed.');
            return;
        }
        if (activeItem.uri.toString() === workspaceFolder.uri.toString()) {
            void vscode.window.showErrorMessage('Popup File Explorer: A workspace root cannot be renamed from this view.');
            return;
        }
        const parentUri = vscode.Uri.joinPath(activeItem.uri, '..');
        const input = vscode.window.showInputBox({
            title: `Rename ${activeItem.entryKind === 'directory' ? 'Folder' : 'File'}`,
            prompt: `Rename in ${vscode.workspace.asRelativePath(parentUri, false) || workspaceFolder.name}`,
            value: activeItem.uri.path.split('/').pop() ?? '',
            ignoreFocusOut: true,
            validateInput: (value) => {
                const name = value.trim();
                if (!name) {
                    return 'Enter a name.';
                }
                if (name === '.' || name === '..' || /[\\/]/.test(name)) {
                    return 'Enter a single name without path separators.';
                }
                return undefined;
            },
        });
        void input.then(async (value) => {
            if (value === undefined) {
                openExplorer(activeItem.uri);
                return;
            }
            const newName = value.trim();
            const newUri = vscode.Uri.joinPath(parentUri, newName);
            if (newUri.toString() === activeItem.uri.toString()) {
                openExplorer(activeItem.uri);
                return;
            }
            try {
                await vscode.workspace.fs.rename(activeItem.uri, newUri, { overwrite: false });
                openExplorer(newUri);
            }
            catch (error) {
                showError(error);
                openExplorer(activeItem.uri);
            }
        }, (error) => {
            showError(error);
            openExplorer(activeItem.uri);
        });
    };
    const startCreateEntry = (kind) => {
        const activeItem = getActiveItem();
        const activeEntry = activeItem ? findEntry(visibleEntries, activeItem.uri) : undefined;
        const parentUri = activeEntry
            ? activeEntry.kind === 'directory'
                ? activeEntry.uri
                : vscode.Uri.joinPath(activeEntry.uri, '..')
            : roots[0]?.uri;
        const parent = parentUri ? findEntry(visibleEntries, parentUri) : undefined;
        if (!parent || parent.kind !== 'directory') {
            void vscode.window.showErrorMessage('Popup File Explorer: Select a workspace folder or file first.');
            return;
        }
        setNavigationMode(false);
        void vscode.window.showInputBox({
            title: kind === 'file' ? 'Create File' : 'Create Folder',
            prompt: `Create inside ${vscode.workspace.asRelativePath(parent.uri, false) || parent.name}`,
            placeHolder: kind === 'file' ? 'File name' : 'Folder name',
            ignoreFocusOut: true,
            validateInput: (value) => {
                const name = value.trim();
                if (!name) {
                    return 'Enter a name.';
                }
                if (name === '.' || name === '..' || /[\\/]/.test(name)) {
                    return 'Enter a single name without path separators.';
                }
                return undefined;
            },
        }).then(async (value) => {
            if (value === undefined) {
                openExplorer(activeItem?.uri);
                return;
            }
            const name = value.trim();
            const uri = vscode.Uri.joinPath(parent.uri, name);
            try {
                try {
                    await vscode.workspace.fs.stat(uri);
                    throw new Error(`An entry named "${name}" already exists.`);
                }
                catch (error) {
                    if (!(error instanceof vscode.FileSystemError) || error.code !== 'FileNotFound') {
                        throw error;
                    }
                }
                if (kind === 'directory') {
                    await vscode.workspace.fs.createDirectory(uri);
                }
                else {
                    const edit = new vscode.WorkspaceEdit();
                    edit.createFile(uri);
                    if (!await vscode.workspace.applyEdit(edit)) {
                        throw new Error(`Could not create "${name}".`);
                    }
                }
                openExplorer(uri);
            }
            catch (error) {
                showError(error);
                openExplorer(activeItem?.uri);
            }
        }, showError);
    };
    popupActions = {
        moveActiveItem: (offset) => {
            const items = quickPick.items;
            if (items.length === 0) {
                return;
            }
            const activeIndex = items.findIndex((item) => item.uri.toString() === getActiveItem()?.uri.toString());
            const nextIndex = Math.max(0, Math.min(items.length - 1, (activeIndex < 0 ? 0 : activeIndex) + offset));
            quickPick.activeItems = [items[nextIndex]];
        },
        toggleActiveFolder: () => {
            const item = getActiveItem();
            if (item?.entryKind === 'directory') {
                toggleFolder(item.uri);
            }
        },
        deleteActiveEntry,
        renameActiveEntry,
        collapseAllFolders,
        startCreateEntry,
        setNavigationMode,
        toggleNavigationMode,
    };
    const addSearchPath = (folderUri, fileUri, rootsById) => {
        const root = rootsById.get(folderUri.toString());
        if (!root) {
            return;
        }
        const relativePath = vscode.workspace.asRelativePath(fileUri, false);
        const segments = relativePath.split(/[\\/]/).filter(Boolean);
        let parent = root;
        let parentUri = folderUri;
        for (let index = 0; index < segments.length; index += 1) {
            const name = segments[index];
            const isFile = index === segments.length - 1;
            const uri = isFile ? fileUri : vscode.Uri.joinPath(parentUri, name);
            parent.children ??= [];
            let child = parent.children.find((entry) => entry.uri.toString() === uri.toString());
            if (!child) {
                child = {
                    uri,
                    name,
                    kind: isFile ? 'file' : 'directory',
                    children: isFile ? undefined : [],
                    loaded: true,
                    expanded: !isFile,
                };
                parent.children.push(child);
            }
            if (!isFile) {
                parent = child;
                parentUri = uri;
            }
        }
    };
    const setSearchItems = async (value, request) => {
        const query = value.trim().toLowerCase();
        if (!query) {
            await setTreeItems(request);
            return;
        }
        searchMode = true;
        quickPick.matchOnDescription = false;
        quickPick.busy = true;
        const files = await vscode.workspace.findFiles('**/*', null, 1000);
        if (request !== searchRequest) {
            return;
        }
        const searchRoots = (vscode.workspace.workspaceFolders ?? []).map((folder) => ({
            uri: folder.uri,
            name: folder.name,
            kind: 'directory',
            children: [],
            loaded: true,
            expanded: true,
        }));
        const rootsById = new Map(searchRoots.map((root) => [root.uri.toString(), root]));
        for (const file of files) {
            const workspaceFolder = vscode.workspace.getWorkspaceFolder(file);
            if (workspaceFolder && file.path.toLowerCase().includes(query)) {
                addSearchPath(workspaceFolder.uri, file, rootsById);
            }
        }
        const sortTree = (entries) => {
            entries.sort((left, right) => {
                if (left.kind !== right.kind) {
                    return left.kind === 'directory' ? -1 : 1;
                }
                return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' });
            });
            for (const entry of entries) {
                if (entry.children) {
                    sortTree(entry.children);
                }
            }
        };
        for (const root of searchRoots) {
            sortTree(root.children ?? []);
        }
        visibleEntries = searchRoots.filter((root) => (root.children?.length ?? 0) > 0);
        const items = await flattenTree(visibleEntries, 0, request);
        if (request === searchRequest) {
            quickPick.items = items;
            quickPick.busy = false;
            if (items.length === 0) {
                quickPick.placeholder = 'No matching workspace files';
            }
        }
    };
    quickPick.onDidChangeValue((value) => {
        setNavigationMode(false);
        const request = ++searchRequest;
        quickPick.placeholder = roots.length
            ? 'Search workspace files or expand folders'
            : 'Open a workspace folder to browse files';
        void setSearchItems(value, request).catch((error) => {
            quickPick.busy = false;
            showError(error);
        });
    });
    quickPick.onDidAccept(() => {
        const selected = quickPick.activeItems[0] ?? quickPick.selectedItems[0];
        if (!selected) {
            return;
        }
        const entry = findEntry(visibleEntries, selected.uri);
        if (selected.entryKind === 'directory' && entry) {
            toggleFolder(selected.uri);
            return;
        }
        const uri = selected.uri;
        quickPick.hide();
        void vscode.workspace.openTextDocument(uri)
            .then((document) => vscode.window.showTextDocument(document, { preview: true }))
            .then(undefined, showError);
    });
    quickPick.onDidHide(() => {
        popupActions = undefined;
        setContext('popupFileExplorerVisible', false);
        setNavigationMode(false);
        quickPick.dispose();
    });
    setContext('popupFileExplorerVisible', true);
    setNavigationMode(true);
    quickPick.show();
    const request = ++searchRequest;
    const initialize = initialSelectionUri
        ? revealEntry(initialSelectionUri).then(() => setTreeItems(request, initialSelectionUri))
        : setTreeItems(request);
    void initialize.catch(showError);
}
function findEntry(entries, uri) {
    for (const entry of entries) {
        if (entry.uri.toString() === uri.toString()) {
            return entry;
        }
        if (entry.children) {
            const child = findEntry(entry.children, uri);
            if (child) {
                return child;
            }
        }
    }
    return undefined;
}
function deactivate() { }
//# sourceMappingURL=extension.js.map