import * as vscode from 'vscode';

type EntryKind = 'directory' | 'file';

interface ExplorerEntry {
  uri: vscode.Uri;
  name: string;
  kind: EntryKind;
  children?: ExplorerEntry[];
  loaded: boolean;
  expanded: boolean;
}

interface ExplorerQuickPickItem extends vscode.QuickPickItem {
  uri: vscode.Uri;
  entryKind: EntryKind;
}

interface ShortcutQuickPickItem extends vscode.QuickPickItem {
  shortcutMenu: true;
}

type PopupQuickPickItem = ExplorerQuickPickItem | ShortcutQuickPickItem;

function isExplorerQuickPickItem(item: PopupQuickPickItem | undefined): item is ExplorerQuickPickItem {
  return item !== undefined && !('shortcutMenu' in item);
}

interface PopupActions {
  moveActiveItem: (offset: number) => void;
  toggleActiveFolder: () => void;
  deleteActiveEntry: () => void;
  renameActiveEntry: () => void;
  cutActiveEntry: () => void;
  pasteEntry: () => void;
  undoDelete: () => void;
  collapseAllFolders: () => void;
  toggleHiddenFiles: () => void;
  startCreateEntry: (kind: EntryKind) => void;
  setNavigationMode: (enabled: boolean) => void;
  toggleNavigationMode: () => void;
}

let popupActions: PopupActions | undefined;

interface DeletedFileBackup {
  originalUri: string;
  backupUri: string;
}

interface ExplorerVisibilityFilter {
  excludePattern?: string;
}

const undoDeleteStateKey = 'popupFileExplorer.deletedFileBackups';

export function activate(context: vscode.ExtensionContext): void {
  const deletedFileBackups = context.globalState.get<DeletedFileBackup[]>(undoDeleteStateKey, []);
  context.subscriptions.push(
    vscode.commands.registerCommand('popupFileExplorer.open', () => openExplorer(context)),
    vscode.commands.registerCommand(
      'popupFileExplorer.focusUp',
      () => popupActions?.moveActiveItem(-1),
    ),
    vscode.commands.registerCommand(
      'popupFileExplorer.focusDown',
      () => popupActions?.moveActiveItem(1),
    ),
    vscode.commands.registerCommand(
      'popupFileExplorer.toggleExpand',
      () => popupActions?.toggleActiveFolder(),
    ),
    vscode.commands.registerCommand(
      'popupFileExplorer.deleteEntry',
      () => popupActions?.deleteActiveEntry(),
    ),
    vscode.commands.registerCommand(
      'popupFileExplorer.renameEntry',
      () => popupActions?.renameActiveEntry(),
    ),
    vscode.commands.registerCommand(
      'popupFileExplorer.cutEntry',
      () => popupActions?.cutActiveEntry(),
    ),
    vscode.commands.registerCommand(
      'popupFileExplorer.pasteEntry',
      () => popupActions?.pasteEntry(),
    ),
    vscode.commands.registerCommand(
      'popupFileExplorer.undoDelete',
      () => popupActions?.undoDelete(),
    ),
    vscode.commands.registerCommand(
      'popupFileExplorer.collapseAll',
      () => popupActions?.collapseAllFolders(),
    ),
    vscode.commands.registerCommand(
      'popupFileExplorer.toggleHiddenFiles',
      () => popupActions?.toggleHiddenFiles(),
    ),
    vscode.commands.registerCommand(
      'popupFileExplorer.createFile',
      () => popupActions?.startCreateEntry('file'),
    ),
    vscode.commands.registerCommand(
      'popupFileExplorer.createFolder',
      () => popupActions?.startCreateEntry('directory'),
    ),
    vscode.commands.registerCommand(
      'popupFileExplorer.focusTree',
      () => popupActions?.setNavigationMode(true),
    ),
    vscode.commands.registerCommand(
      'popupFileExplorer.focusSearch',
      () => popupActions?.setNavigationMode(false),
    ),
    vscode.commands.registerCommand(
      'popupFileExplorer.toggleNavigationMode',
      () => popupActions?.toggleNavigationMode(),
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('popupFileExplorer._deleteFileWithUndo', async (uri: vscode.Uri) => {
      const backupUri = vscode.Uri.joinPath(context.globalStorageUri, 'deleted', `${Date.now()}-${Math.random().toString(36).slice(2)}`);
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(backupUri, '..'));
      await vscode.workspace.fs.copy(uri, backupUri, { overwrite: false });
      const backup = { originalUri: uri.toString(), backupUri: backupUri.toString() };
      deletedFileBackups.push(backup);
      try {
        await context.globalState.update(undoDeleteStateKey, deletedFileBackups);
        await vscode.workspace.fs.delete(uri, { useTrash: true });
      } catch (error) {
        deletedFileBackups.pop();
        await context.globalState.update(undoDeleteStateKey, deletedFileBackups);
        await vscode.workspace.fs.delete(backupUri);
        throw error;
      }
    }),
    vscode.commands.registerCommand('popupFileExplorer._undoDelete', async (): Promise<string> => {
      const backup = deletedFileBackups[deletedFileBackups.length - 1];
      if (!backup) {
        throw new Error('There is no recently deleted file to restore.');
      }

      const originalUri = vscode.Uri.parse(backup.originalUri);
      try {
        await vscode.workspace.fs.stat(originalUri);
        throw new Error(`Cannot restore "${originalUri.path}": an entry already exists there.`);
      } catch (error) {
        if (!(error instanceof vscode.FileSystemError) || error.code !== 'FileNotFound') {
          throw error;
        }
      }

      await vscode.workspace.fs.copy(vscode.Uri.parse(backup.backupUri), originalUri, { overwrite: false });
      await vscode.workspace.fs.delete(vscode.Uri.parse(backup.backupUri));
      deletedFileBackups.pop();
      await context.globalState.update(undoDeleteStateKey, deletedFileBackups);
      return originalUri.toString();
    }),
  );
}

function openExplorer(
  context: vscode.ExtensionContext,
  initialSelectionUri?: vscode.Uri,
  cutUri?: vscode.Uri,
  includeExcludedEntries = false,
): void {
  const quickPick = vscode.window.createQuickPick<PopupQuickPickItem>();
  let currentCutUri = cutUri;
  let showExcludedEntries = includeExcludedEntries;
  const roots: ExplorerEntry[] = (vscode.workspace.workspaceFolders ?? []).map((folder) => ({
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
  let lastActiveUri: vscode.Uri | undefined;
  const visibleEntryIdsByDirectory = new Map<string, Set<string>>();
  let shortcutMenuOpen = false;
  let explorerStateBeforeShortcutMenu: {
    items: readonly PopupQuickPickItem[];
    activeItems: readonly PopupQuickPickItem[];
    visibleEntries: ExplorerEntry[];
    title: string | undefined;
    placeholder: string | undefined;
    prompt: string | undefined;
    value: string;
    matchOnDescription: boolean;
    treeNavigationMode: boolean;
  } | undefined;
  const shortcutsButton: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon('menu'),
    tooltip: 'Show keyboard shortcuts',
  };
  const shortcuts = [
    { category: 'Explorer navigation', bindings: [
      ['W / S', 'Move selection'],
      ['Space', 'Expand or collapse folder'],
      ['A', 'Collapse all folders'],
    ] },
    { category: 'File operations', bindings: [
      ['D', 'Remove selected file or folder'],
      ['R', 'Rename selected file or folder'],
      ['N / M', 'Create file / folder'],
      ['H', 'Show or hide Files: Exclude entries'],
      ['Ctrl+X / Ctrl+V', 'Cut / paste selected entry'],
      ['Ctrl+Z', 'Restore the last removed file'],
    ] },
    { category: 'Focus and search', bindings: [
      ['Tab', 'Toggle Explorer / Search'],
      ['Alt+S', 'Focus Explorer'],
      ['Alt+W', 'Focus Search'],
      ['Shift+Tab', 'Focus Search from Explorer'],
    ] },
    { category: 'Open popup', bindings: [
      ['Ctrl+Alt+E', 'Open Popup File Explorer (Windows / Linux)'],
      ['Cmd+Option+E', 'Open Popup File Explorer (macOS)'],
    ] },
  ];

  quickPick.title = 'Popup File Explorer';
  quickPick.placeholder = roots.length
    ? 'Search workspace files or expand folders'
    : 'Open a workspace folder to browse files';
  quickPick.matchOnDescription = true;
  quickPick.ignoreFocusOut = false;
  quickPick.buttons = [shortcutsButton];

  const showError = (error: unknown): void => {
    const detail = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`Popup File Explorer: ${detail}`);
  };
  const reopen = (
    uri?: vscode.Uri,
    nextCutUri = currentCutUri,
    nextIncludeExcludedEntries = showExcludedEntries,
  ): void => {
    openExplorer(context, uri, nextCutUri, nextIncludeExcludedEntries);
  };

  const getVisibilityFilter = (): ExplorerVisibilityFilter => {
    if (showExcludedEntries) {
      return {};
    }

    const excludes = vscode.workspace.getConfiguration('files').get<Record<string, boolean>>('exclude', {});
    const patterns = Object.entries(excludes)
      .filter(([, excluded]) => excluded)
      .map(([pattern]) => pattern);
    return patterns.length > 0
      ? { excludePattern: patterns.length === 1 ? patterns[0] : `{${patterns.join(',')}}` }
      : {};
  };

  const setContext = (key: string, value: boolean): void => {
    void vscode.commands.executeCommand('setContext', key, value).then(undefined, showError);
  };

  const setNavigationMode = (enabled: boolean): void => {
    if (shortcutMenuOpen) {
      return;
    }

    const changed = treeNavigationMode !== enabled;
    if (changed && !enabled) {
      const activeItem = quickPick.activeItems[0];
      if (isExplorerQuickPickItem(activeItem)) {
        lastActiveUri = activeItem.uri;
      }
      quickPick.activeItems = [];
    }

    treeNavigationMode = enabled;
    setContext('popupFileExplorerTreeFocus', enabled);
    if (changed && enabled) {
      const activeItem = quickPick.items.find(
        (item) => isExplorerQuickPickItem(item) && item.uri.toString() === lastActiveUri?.toString(),
      ) ?? quickPick.items[0];
      quickPick.activeItems = isExplorerQuickPickItem(activeItem) ? [activeItem] : [];
    }
    const cutHint = currentCutUri
      ? ` | CUT: ${currentCutUri.path.split('/').pop()}  Ctrl+V: move`
      : '';
    quickPick.prompt = enabled
      ? `EXPLORER${cutHint}`
      : 'SEARCH';
  };

  const toggleNavigationMode = (): void => {
    if (shortcutMenuOpen) {
      return;
    }
    setNavigationMode(!treeNavigationMode);
  };

  const openShortcutMenu = (): void => {
    if (shortcutMenuOpen) {
      return;
    }

    explorerStateBeforeShortcutMenu = {
      items: quickPick.items,
      activeItems: quickPick.activeItems,
      visibleEntries,
      title: quickPick.title,
      placeholder: quickPick.placeholder,
      prompt: quickPick.prompt,
      value: quickPick.value,
      matchOnDescription: quickPick.matchOnDescription,
      treeNavigationMode,
    };
    setNavigationMode(false);
    shortcutMenuOpen = true;
    ++searchRequest;
    quickPick.title = 'Popup File Explorer — Keyboard Shortcuts';
    quickPick.placeholder = 'Keyboard shortcuts';
    quickPick.prompt = 'Use the back button to return to the explorer';
    quickPick.value = '';
    quickPick.matchOnDescription = true;
    quickPick.buttons = [vscode.QuickInputButtons.Back];
    quickPick.activeItems = [];
    quickPick.items = shortcuts.flatMap(({ category, bindings }) => [
      { label: category, kind: vscode.QuickPickItemKind.Separator, shortcutMenu: true as const },
      ...bindings.map(([key, description]) => ({
        label: key,
        description,
        shortcutMenu: true as const,
      })),
    ]);
  };

  const closeShortcutMenu = (): void => {
    const state = explorerStateBeforeShortcutMenu;
    if (!shortcutMenuOpen || !state) {
      return;
    }

    quickPick.value = state.value;
    quickPick.title = state.title;
    quickPick.placeholder = state.placeholder;
    quickPick.prompt = state.prompt;
    quickPick.matchOnDescription = state.matchOnDescription;
    quickPick.items = state.items;
    quickPick.activeItems = state.activeItems.filter(
      (item): item is ExplorerQuickPickItem => 'uri' in item && 'entryKind' in item,
    );
    visibleEntries = state.visibleEntries;
    shortcutMenuOpen = false;
    explorerStateBeforeShortcutMenu = undefined;
    quickPick.buttons = [shortcutsButton];
    setNavigationMode(state.treeNavigationMode);
  };

  quickPick.onDidTriggerButton((button) => {
    if (button === shortcutsButton) {
      openShortcutMenu();
    } else if (button === vscode.QuickInputButtons.Back) {
      closeShortcutMenu();
    }
  });

  const toggleHiddenFiles = (): void => {
    if (shortcutMenuOpen) {
      return;
    }
    reopen(getActiveItem()?.uri, currentCutUri, !showExcludedEntries);
  };

  quickPick.onDidChangeActive((items) => {
    if (shortcutMenuOpen) {
      return;
    }
    if (treeNavigationMode && items[0]) {
      const activeItem = items[0];
      if (isExplorerQuickPickItem(activeItem)) {
        lastActiveUri = activeItem.uri;
      }
    } else if (!treeNavigationMode && items.length > 0) {
      quickPick.activeItems = [];
    }
  });

  const readChildren = async (entry: ExplorerEntry): Promise<ExplorerEntry[]> => {
    if (entry.loaded) {
      return entry.children ?? [];
    }

    const filter = getVisibilityFilter();
    const entries = await vscode.workspace.fs.readDirectory(entry.uri);
    let visibleEntryIds: Set<string> | undefined;
    if (filter.excludePattern) {
      const directoryId = entry.uri.toString();
      visibleEntryIds = visibleEntryIdsByDirectory.get(directoryId);
      if (!visibleEntryIds) {
        visibleEntryIds = new Set<string>();
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(entry.uri);
        const files = await vscode.workspace.findFiles(
          new vscode.RelativePattern(entry.uri, '**/*'),
          workspaceFolder
            ? new vscode.RelativePattern(workspaceFolder, filter.excludePattern)
            : null,
        );
        for (const file of files) {
          let current = file;
          while (current.toString() !== entry.uri.toString()
            && current.path.startsWith(`${entry.uri.path.replace(/\/$/, '')}/`)) {
            visibleEntryIds.add(current.toString());
            current = vscode.Uri.joinPath(current, '..');
          }
        }
        visibleEntryIdsByDirectory.set(directoryId, visibleEntryIds);
      }
    }
    entry.children = entries
      .map(([name, type]) => ({
        uri: vscode.Uri.joinPath(entry.uri, name),
        name,
        kind: (type & vscode.FileType.Directory) !== 0 ? 'directory' as const : 'file' as const,
        loaded: false,
        expanded: false,
      }))
      .filter((child) => !visibleEntryIds || visibleEntryIds.has(child.uri.toString()))
      .sort((left, right) => {
        if (left.kind !== right.kind) {
          return left.kind === 'directory' ? -1 : 1;
        }
        return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' });
      });
    entry.loaded = true;
    return entry.children;
  };

  const revealEntry = async (uri: vscode.Uri): Promise<ExplorerEntry | undefined> => {
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
      } else {
        return child;
      }
    }
    return entry;
  };

  const flattenTree = async (
    entries: ExplorerEntry[],
    depth: number,
    request: number,
  ): Promise<ExplorerQuickPickItem[]> => {
    const items: ExplorerQuickPickItem[] = [];
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

  const setTreeItems = async (request: number, activeUri?: vscode.Uri): Promise<void> => {
    searchMode = false;
    quickPick.matchOnDescription = true;
    quickPick.busy = true;
    visibleEntries = roots;
    await renderVisibleTree(request, activeUri);
  };

  const renderVisibleTree = async (request: number, activeUri?: vscode.Uri): Promise<void> => {
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

  const getActiveItem = (): ExplorerQuickPickItem | undefined => {
    const item = quickPick.activeItems[0] ?? quickPick.items[0];
    return isExplorerQuickPickItem(item) ? item : undefined;
  };

  const toggleFolder = (uri: vscode.Uri): void => {
    const entry = findEntry(visibleEntries, uri);
    if (!entry || entry.kind !== 'directory') {
      return;
    }

    entry.expanded = !entry.expanded;
    const request = ++searchRequest;
    void renderVisibleTree(request, uri).catch(showError);
  };

  const collapseAllFolders = (): void => {
    if (shortcutMenuOpen) {
      return;
    }

    const collapse = (entries: ExplorerEntry[]): void => {
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

  const deleteActiveEntry = (): void => {
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

    const parentUri = vscode.Uri.joinPath(activeItem.uri, '..');
    const removeEntry = async (): Promise<void> => {
      try {
        if (activeItem.entryKind === 'directory') {
          await vscode.workspace.fs.delete(activeItem.uri, { recursive: true, useTrash: true });
        } else {
          await vscode.commands.executeCommand(
            'popupFileExplorer._deleteFileWithUndo',
            activeItem.uri,
          );
        }
        reopen(parentUri);
      } catch (error) {
        showError(error);
      }
    };

    if (activeItem.entryKind === 'file') {
      void removeEntry();
      return;
    }

    void vscode.window.showInputBox({
      title: 'Confirm Removal',
      prompt: 'Do you really want to remove this folder? Type YES to confirm.',
      placeHolder: 'Type YES to confirm',
      ignoreFocusOut: true,
      validateInput: (value) => value === 'YES' ? undefined : 'Type YES to confirm removal.',
    }).then((confirmation) => {
      if (confirmation === 'YES') {
        void removeEntry();
      } else {
        reopen(activeItem.uri);
      }
    }, showError);
  };

  const cutActiveEntry = (): void => {
    const activeItem = getActiveItem();
    if (!activeItem) {
      return;
    }

    const workspaceFolder = vscode.workspace.getWorkspaceFolder(activeItem.uri);
    if (!workspaceFolder || activeItem.uri.toString() === workspaceFolder.uri.toString()) {
      void vscode.window.showErrorMessage('Popup File Explorer: Select a workspace file or non-root folder to cut.');
      return;
    }

    currentCutUri = activeItem.uri;
    setNavigationMode(treeNavigationMode);
  };

  const pasteEntry = async (): Promise<void> => {
    if (!currentCutUri) {
      void vscode.window.showInformationMessage('Popup File Explorer: No cut file or folder to paste.');
      return;
    }

    const sourceUri = currentCutUri;
    const sourceFolder = vscode.workspace.getWorkspaceFolder(sourceUri);
    if (!sourceFolder || sourceUri.toString() === sourceFolder.uri.toString()) {
      void vscode.window.showErrorMessage('Popup File Explorer: The cut entry is no longer available.');
      return;
    }

    const activeItem = getActiveItem();
    const activeEntry = activeItem ? findEntry(visibleEntries, activeItem.uri) : undefined;
    const destinationDirectory = activeEntry
      ? activeEntry.kind === 'directory'
        ? activeEntry.uri
        : vscode.Uri.joinPath(activeEntry.uri, '..')
      : roots[0]?.uri;
    if (!destinationDirectory) {
      void vscode.window.showErrorMessage('Popup File Explorer: Select a destination folder first.');
      return;
    }

    try {
      const sourceStat = await vscode.workspace.fs.stat(sourceUri);
      const destinationStat = await vscode.workspace.fs.stat(destinationDirectory);
      if ((destinationStat.type & vscode.FileType.Directory) === 0) {
        throw new Error('The selected paste destination is not a folder.');
      }
      if ((sourceStat.type & vscode.FileType.Directory) !== 0
        && (destinationDirectory.toString() === sourceUri.toString()
          || destinationDirectory.scheme === sourceUri.scheme
          && destinationDirectory.authority === sourceUri.authority
          && destinationDirectory.path.startsWith(`${sourceUri.path.replace(/\/$/, '')}/`))) {
        throw new Error('A folder cannot be moved into itself or one of its subfolders.');
      }

      const newUri = vscode.Uri.joinPath(destinationDirectory, sourceUri.path.split('/').pop() ?? '');
      if (newUri.toString() === sourceUri.toString()) {
        currentCutUri = undefined;
        setNavigationMode(treeNavigationMode);
        return;
      }

      try {
        await vscode.workspace.fs.stat(newUri);
        throw new Error('An entry with that name already exists at the destination.');
      } catch (error) {
        if (!(error instanceof vscode.FileSystemError) || error.code !== 'FileNotFound') {
          throw error;
        }
      }

      await vscode.workspace.fs.rename(sourceUri, newUri, { overwrite: false });
      currentCutUri = undefined;
      reopen(newUri, undefined);
    } catch (error) {
      showError(error);
    }
  };

  const undoDelete = async (): Promise<void> => {
    try {
      const restoredUri = await vscode.commands.executeCommand<string>('popupFileExplorer._undoDelete');
      if (restoredUri) {
        reopen(vscode.Uri.parse(restoredUri));
      }
    } catch (error) {
      showError(error);
    }
  };

  const renameActiveEntry = (): void => {
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
        reopen(activeItem.uri);
        return;
      }

      const newName = value.trim();
      const newUri = vscode.Uri.joinPath(parentUri, newName);
      if (newUri.toString() === activeItem.uri.toString()) {
        reopen(activeItem.uri);
        return;
      }

      try {
        await vscode.workspace.fs.rename(activeItem.uri, newUri, { overwrite: false });
        reopen(newUri);
      } catch (error) {
        showError(error);
        reopen(activeItem.uri);
      }
    }, (error: unknown) => {
      showError(error);
      reopen(activeItem.uri);
    });
  };

  const startCreateEntry = (kind: EntryKind): void => {
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
        reopen(activeItem?.uri);
        return;
      }

      const name = value.trim();
      const uri = vscode.Uri.joinPath(parent.uri, name);
      try {
        try {
          await vscode.workspace.fs.stat(uri);
          throw new Error(`An entry named "${name}" already exists.`);
        } catch (error) {
          if (!(error instanceof vscode.FileSystemError) || error.code !== 'FileNotFound') {
            throw error;
          }
        }

        if (kind === 'directory') {
          await vscode.workspace.fs.createDirectory(uri);
        } else {
          const edit = new vscode.WorkspaceEdit();
          edit.createFile(uri);
          if (!await vscode.workspace.applyEdit(edit)) {
            throw new Error(`Could not create "${name}".`);
          }
        }
        reopen(uri);
      } catch (error) {
        showError(error);
        reopen(activeItem?.uri);
      }
    }, showError);
  };

  const actions: PopupActions = {
    moveActiveItem: (offset) => {
      if (shortcutMenuOpen) {
        return;
      }
      const items = quickPick.items;
      const explorerItems = items.filter(isExplorerQuickPickItem);
      if (explorerItems.length === 0) {
        return;
      }

      const activeIndex = explorerItems.findIndex((item) => item.uri.toString() === getActiveItem()?.uri.toString());
      const nextIndex = Math.max(0, Math.min(explorerItems.length - 1, (activeIndex < 0 ? 0 : activeIndex) + offset));
      quickPick.activeItems = [explorerItems[nextIndex]];
    },
    toggleActiveFolder: () => {
      const item = getActiveItem();
      if (item?.entryKind === 'directory') {
        toggleFolder(item.uri);
      }
    },
    deleteActiveEntry,
    renameActiveEntry,
    cutActiveEntry,
    pasteEntry,
    undoDelete,
    collapseAllFolders,
    toggleHiddenFiles,
    startCreateEntry,
    setNavigationMode,
    toggleNavigationMode,
  };
  popupActions = actions;

  const addSearchPath = (folderUri: vscode.Uri, fileUri: vscode.Uri, rootsById: Map<string, ExplorerEntry>): void => {
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

  const setSearchItems = async (value: string, request: number): Promise<void> => {
    const query = value.trim().toLowerCase();
    if (!query) {
      await setTreeItems(request);
      return;
    }

    searchMode = true;
    quickPick.matchOnDescription = false;
    quickPick.busy = true;
    const visibilityFilter = getVisibilityFilter();
    const files = await vscode.workspace.findFiles('**/*', visibilityFilter.excludePattern ?? null, 1000);
    if (request !== searchRequest) {
      return;
    }

    const searchRoots: ExplorerEntry[] = (vscode.workspace.workspaceFolders ?? []).map((folder) => ({
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
      if (workspaceFolder
        && file.path.toLowerCase().includes(query)) {
        addSearchPath(workspaceFolder.uri, file, rootsById);
      }
    }

    const sortTree = (entries: ExplorerEntry[]): void => {
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
    if (shortcutMenuOpen) {
      return;
    }

    setNavigationMode(false);
    const request = ++searchRequest;
    quickPick.placeholder = roots.length
      ? 'Search workspace files or expand folders'
      : 'Open a workspace folder to browse files';
    void setSearchItems(value, request).catch((error: unknown) => {
      quickPick.busy = false;
      showError(error);
    });
  });

  quickPick.onDidAccept(() => {
    if (shortcutMenuOpen) {
      return;
    }

    const selected = quickPick.activeItems[0] ?? quickPick.selectedItems[0];
    if (!isExplorerQuickPickItem(selected)) {
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
    if (popupActions === actions) {
      popupActions = undefined;
      setContext('popupFileExplorerVisible', false);
      setNavigationMode(false);
    }
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

function findEntry(entries: ExplorerEntry[], uri: vscode.Uri): ExplorerEntry | undefined {
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

export function deactivate(): void {}
