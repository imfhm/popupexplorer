# Popup File Explorer

Open the native searchable file popup with **Ctrl+Alt+E** (Windows/Linux) or **Cmd+Option+E** (macOS), or run **Popup File Explorer: Open** from the Command Palette.

- Browse the expandable, indented workspace tree in the Quick Pick list; select a folder to expand or collapse it and select a file to open it.
- Search workspace file paths directly in the popup. Matching results are grouped under their ancestor folders, while each row shows only the entry name. Results are limited to the first 1,000 workspace files.
- File and folder icons follow the active VS Code file icon theme; the popup and its colors follow the active VS Code theme.
- The mode indicator stays compact; use the menu button in the popup title bar to browse keyboard shortcuts grouped by navigation, file operations, focus/search, and opening the popup.
- The popup opens in **EXPLORER** mode. **W/S** moves through entries, **Space** expands or collapses a folder, **D** removes the selected entry, **R** renames it, **H** toggles whether files excluded by VS Code's **Files: Exclude** setting are shown, **Ctrl+X/Ctrl+V** cuts and moves it, **Ctrl+Z** restores the most recently removed file, **A** collapses all folders, and **N/M** creates a file or folder. To move an entry, cut it, select a destination folder (or a file in the destination folder), then paste. File removal is immediate and recoverable with Ctrl+Z; folder removal asks for `YES`, is recursive, and uses the system trash when available. Press **Tab** to toggle between Explorer and search; **Alt+S/Alt+W** and **Shift+Tab** are also available. During search, rows show only entry names. New entries are created inside the selected folder, or beside the selected file.
- File visibility follows VS Code's `files.exclude` setting (the **Files: Exclude** setting), which uses glob patterns such as `"**/*.bib": true`, not regular expressions. **H** temporarily toggles those exclusions in the popup without changing your VS Code settings.
- Customize shortcuts through **Preferences: Open Keyboard Shortcuts** or `keybindings.json`. VS Code extensions can contribute default shortcuts and commands, but cannot provide settings that dynamically change keybindings.

The Quick Pick API controls row filtering and focus, so brief active-row flicker during typing cannot be fully disabled. The extension clears transient active rows as they appear to minimize it.

The native Quick Pick keeps its search input focused in both navigation modes. VS Code's extension API does not expose a way to blur the input or control its text caret.

The popup is the native VS Code Quick Pick overlay, not a separate operating-system window. VS Code controls its placement and does not expose an API for positioning it at the text cursor.

## Development

- `npm install`
- `npm run compile`
