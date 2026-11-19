import { spawn } from 'node:child_process';
import os from 'node:os';

import type { NativeFolderPicker, NativeFolderPickerRequest } from '@/shared/types.js';

/**
 * The OS folder dialog runs in its own process and blocks until the user
 * answers it, so a runaway dialog nobody ever sees is killed instead of
 * holding the request open forever.
 */
const DIALOG_TIMEOUT_MILLISECONDS = 10 * 60 * 1000;

const CANCELLED_EXIT_CODE = 2;

type DialogCommand = {
  command: string;
  commandArguments: string[];
  environment?: Record<string, string>;
};

/**
 * Windows has no command-line folder picker, so the Vista-style
 * `IFileOpenDialog` is driven from PowerShell: it is the only folder dialog
 * that can select more than one folder at a time. The selection arrives on
 * stdout, one absolute path per line.
 *
 * A hidden top-most window owns the dialog, which is what brings it in front
 * of the browser instead of behind it.
 */
const WINDOWS_PICKER_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

namespace CloudCli {
  [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  internal interface IShellItem {
    void BindToHandler(IntPtr bindContext, ref Guid handlerId, ref Guid interfaceId, out IntPtr instance);
    void GetParent(out IShellItem parent);
    void GetDisplayName(uint nameForm, out IntPtr name);
    void GetAttributes(uint mask, out uint attributes);
    void Compare(IShellItem other, uint hint, out int order);
  }

  [ComImport, Guid("b63ea76d-1f85-456f-a19c-48159efa858b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  internal interface IShellItemArray {
    void BindToHandler(IntPtr bindContext, ref Guid handlerId, ref Guid interfaceId, out IntPtr instance);
    void GetPropertyStore(int flags, ref Guid interfaceId, out IntPtr instance);
    void GetPropertyDescriptionList(IntPtr propertyKeyType, ref Guid interfaceId, out IntPtr instance);
    void GetAttributes(int selection, uint mask, out uint attributes);
    void GetCount(out uint itemCount);
    void GetItemAt(uint index, out IShellItem item);
    void EnumItems(out IntPtr enumerator);
  }

  // The complete vtable of IModalWindow + IFileDialog + IFileOpenDialog, in order:
  // COM dispatches by slot, so no member may be omitted or reordered.
  [ComImport, Guid("d57c7288-d4ad-4768-be02-9d969532d960"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  internal interface IFileOpenDialog {
    [PreserveSig] int Show(IntPtr owner);
    void SetFileTypes(uint fileTypeCount, IntPtr filterSpecifications);
    void SetFileTypeIndex(uint fileTypeIndex);
    void GetFileTypeIndex(out uint fileTypeIndex);
    void Advise(IntPtr events, out uint cookie);
    void Unadvise(uint cookie);
    void SetOptions(uint options);
    void GetOptions(out uint options);
    void SetDefaultFolder(IShellItem folder);
    void SetFolder(IShellItem folder);
    void GetFolder(out IShellItem folder);
    void GetCurrentSelection(out IShellItem item);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
    void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string name);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string text);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
    void GetResult(out IShellItem item);
    void AddPlace(IShellItem item, int placement);
    void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string defaultExtension);
    void Close(int result);
    void SetClientGuid(ref Guid clientId);
    void ClearClientData();
    void SetFilter(IntPtr filter);
    void GetResults(out IShellItemArray selection);
    void GetSelectedItems(out IShellItemArray selection);
  }

  public static class FolderDialog {
    private const uint PickFolders = 0x20;
    private const uint ForceFilesystem = 0x40;
    private const uint AllowMultiselect = 0x200;
    private const uint PathMustExist = 0x800;
    private const uint NoChangeDirectory = 0x8;
    private const uint FilesystemPathName = 0x80058000;

    private static readonly Guid FileOpenDialogClassId = new Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7");
    private static readonly Guid ShellItemInterfaceId = new Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe");

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    private static extern void SHCreateItemFromParsingName(
      [MarshalAs(UnmanagedType.LPWStr)] string path,
      IntPtr bindContext,
      ref Guid interfaceId,
      [MarshalAs(UnmanagedType.Interface)] out IShellItem item);

    /// <summary>Shows the folder dialog; returns null when the user cancels.</summary>
    public static string[] Pick(bool multiple, string initialPath, string title, IntPtr owner) {
      IFileOpenDialog dialog = (IFileOpenDialog)Activator.CreateInstance(Type.GetTypeFromCLSID(FileOpenDialogClassId));

      uint options = PickFolders | ForceFilesystem | PathMustExist | NoChangeDirectory;
      if (multiple) { options |= AllowMultiselect; }
      dialog.SetOptions(options);

      if (!string.IsNullOrEmpty(title)) { dialog.SetTitle(title); }

      if (!string.IsNullOrEmpty(initialPath)) {
        Guid interfaceId = ShellItemInterfaceId;
        IShellItem startFolder;
        SHCreateItemFromParsingName(initialPath, IntPtr.Zero, ref interfaceId, out startFolder);
        dialog.SetFolder(startFolder);
      }

      if (dialog.Show(owner) != 0) { return null; }

      IShellItemArray selection;
      dialog.GetResults(out selection);
      uint selectedCount;
      selection.GetCount(out selectedCount);

      string[] selectedPaths = new string[selectedCount];
      for (uint index = 0; index < selectedCount; index++) {
        IShellItem selectedItem;
        selection.GetItemAt(index, out selectedItem);
        IntPtr nameBuffer;
        selectedItem.GetDisplayName(FilesystemPathName, out nameBuffer);
        selectedPaths[index] = Marshal.PtrToStringUni(nameBuffer);
        Marshal.FreeCoTaskMem(nameBuffer);
      }
      return selectedPaths;
    }
  }
}
"@

$allowMultiple = $env:CLOUDCLI_PICKER_MULTIPLE -eq '1'

$initialPath = ''
if ($env:CLOUDCLI_PICKER_INITIAL_PATH -and (Test-Path -LiteralPath $env:CLOUDCLI_PICKER_INITIAL_PATH -PathType Container)) {
  $initialPath = (Resolve-Path -LiteralPath $env:CLOUDCLI_PICKER_INITIAL_PATH).ProviderPath
}

$owner = New-Object System.Windows.Forms.Form
$owner.ShowInTaskbar = $false
$owner.TopMost = $true
$owner.StartPosition = 'Manual'
$owner.Location = New-Object System.Drawing.Point(-3000, -3000)
$owner.Size = New-Object System.Drawing.Size(1, 1)
$owner.Show()
$owner.Activate()

try {
  $selectedPaths = [CloudCli.FolderDialog]::Pick(
    $allowMultiple,
    $initialPath,
    $env:CLOUDCLI_PICKER_TITLE,
    $owner.Handle)
} finally {
  $owner.Close()
  $owner.Dispose()
}

if ($null -eq $selectedPaths) { exit ${CANCELLED_EXIT_CODE} }
$selectedPaths | ForEach-Object { Write-Output $_ }
`;

/** AppleScript's own folder chooser; a cancelled dialog exits non-zero on its own. */
const MACOS_PICKER_SCRIPT = (multiple: boolean) => `
set chosen to choose folder${multiple ? ' with multiple selections allowed' : ''}
set output to ""
${multiple
    ? 'repeat with folderAlias in chosen\n  set output to output & POSIX path of folderAlias & linefeed\nend repeat'
    : 'set output to POSIX path of chosen'}
return output
`;

function buildDialogCommand(request: NativeFolderPickerRequest): DialogCommand | null {
  const multiple = request.multiple === true;

  if (process.platform === 'win32') {
    return {
      command: 'powershell.exe',
      commandArguments: [
        '-NoProfile',
        '-STA',
        '-ExecutionPolicy', 'Bypass',
        '-EncodedCommand', Buffer.from(WINDOWS_PICKER_SCRIPT, 'utf16le').toString('base64'),
      ],
      environment: {
        CLOUDCLI_PICKER_MULTIPLE: multiple ? '1' : '0',
        CLOUDCLI_PICKER_INITIAL_PATH: request.initialPath ?? '',
        CLOUDCLI_PICKER_TITLE: request.title ?? '',
      },
    };
  }

  if (process.platform === 'darwin') {
    return { command: 'osascript', commandArguments: ['-e', MACOS_PICKER_SCRIPT(multiple)] };
  }

  return {
    command: 'zenity',
    commandArguments: [
      '--file-selection',
      '--directory',
      '--separator=\n',
      ...(multiple ? ['--multiple'] : []),
      ...(request.initialPath ? [`--filename=${request.initialPath}/`] : []),
      ...(request.title ? [`--title=${request.title}`] : []),
    ],
  };
}

/** A desktop session is what makes a dialog visible at all; a headless Linux server has none. */
function hasDesktopSession(): boolean {
  if (process.platform === 'win32' || process.platform === 'darwin') {
    return true;
  }
  return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

function runDialog(dialog: DialogCommand): Promise<string[] | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(dialog.command, dialog.commandArguments, {
      env: { ...process.env, ...dialog.environment },
      windowsHide: true,
    });

    let standardOutput = '';
    let standardError = '';
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, DIALOG_TIMEOUT_MILLISECONDS);

    child.stdout.on('data', (chunk: Buffer) => { standardOutput += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { standardError += chunk.toString('utf8'); });

    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    child.on('close', (exitCode) => {
      clearTimeout(timeout);

      if (timedOut) {
        reject(new Error('The folder dialog was left open and timed out'));
        return;
      }

      const selectedPaths = standardOutput
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);

      // Every picker reports a cancelled dialog with a non-zero exit and no selection.
      if (selectedPaths.length === 0) {
        if (exitCode === 0 || exitCode === CANCELLED_EXIT_CODE || exitCode === 1) {
          resolve(null);
          return;
        }
        reject(new Error(standardError.trim() || `The folder dialog failed with exit code ${exitCode}`));
        return;
      }

      resolve(selectedPaths);
    });
  });
}

/**
 * Opens the operating system's own folder dialog on the machine the server
 * runs on. Only one dialog exists at a time: a second request while one is
 * open would open a dialog the first one's modal owner hides.
 */
export function createNativeFolderPicker(): NativeFolderPicker {
  let openDialog: Promise<string[] | null> | null = null;

  return {
    isAvailable: () => process.env.NATIVE_FOLDER_PICKER !== '0' && hasDesktopSession(),

    async pick(request) {
      if (openDialog) {
        throw new Error('A folder dialog is already open');
      }

      const dialog = buildDialogCommand(request);
      if (!dialog) {
        throw new Error(`No folder dialog is available on ${os.platform()}`);
      }

      openDialog = runDialog(dialog);
      try {
        return await openDialog;
      } finally {
        openDialog = null;
      }
    },
  };
}
