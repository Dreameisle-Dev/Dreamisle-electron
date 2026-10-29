// Windows UI Automation probe for taskbar button rectangles.
// Pure Node (no Electron): spawns a short-lived Windows PowerShell process and
// parses its JSON output. Unit-testable pieces are exported for `node --test`.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const PROBE_SCRIPT = String.raw`
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes

$root = [System.Windows.Automation.AutomationElement]::RootElement
$hwndValue = __TASKBAR_HWND__
$taskbar = $null
if ($hwndValue -gt 0) {
  # 指定了任务栏 HWND（包括副屏任务栏）就直接取它的 UIA 元素，
  # 不能退回按 Shell_TrayWnd 类名找主任务栏。
  try {
    $taskbar = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$hwndValue)
  } catch {
    $taskbar = $null
  }
} else {
  $classCondition = New-Object -TypeName System.Windows.Automation.PropertyCondition -ArgumentList ([System.Windows.Automation.AutomationElement]::ClassNameProperty), 'Shell_TrayWnd'
  $taskbar = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $classCondition)
}
$taskbarFound = $null -ne $taskbar

$buttons = @()
if ($taskbarFound) {
  $buttonCondition = New-Object -TypeName System.Windows.Automation.PropertyCondition -ArgumentList ([System.Windows.Automation.AutomationElement]::ControlTypeProperty), ([System.Windows.Automation.ControlType]::Button)
  $found = $taskbar.FindAll([System.Windows.Automation.TreeScope]::Descendants, $buttonCondition)
  foreach ($element in $found) {
    $rect = $element.Current.BoundingRectangle
    if ($rect.Width -gt 1) {
      $buttons += @{
        x = [int]$rect.X
        y = [int]$rect.Y
        w = [int]$rect.Width
        h = [int]$rect.Height
      }
    }
  }
}

$advanced = Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced' -ErrorAction SilentlyContinue
$al = $null
if ($null -ne $advanced -and $null -ne $advanced.TaskbarAl) {
  $al = [int]$advanced.TaskbarAl
}

$personalize = Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize' -ErrorAction SilentlyContinue
$light = $null
if ($null -ne $personalize -and $null -ne $personalize.SystemUsesLightTheme) {
  $light = [int]$personalize.SystemUsesLightTheme
}

$build = [Environment]::OSVersion.Version.Build

@{ buttons = @($buttons); taskbarFound = $taskbarFound; taskbarAl = $al; lightTaskbar = $light; osBuild = [int]$build } | ConvertTo-Json -Compress -Depth 4
`;

/**
 * Build the Windows PowerShell probe script. The only interpolated value is a
 * validated decimal HWND; 0 means "find the primary taskbar by class" for
 * backwards compatibility.
 */
export function buildProbeScript(taskbarHwnd = 0) {
  const numeric = Number(taskbarHwnd);
  const safeHwnd = Number.isSafeInteger(numeric) && numeric > 0 ? numeric : 0;
  return PROBE_SCRIPT.replaceAll('__TASKBAR_HWND__', String(safeHwnd));
}

/** Encode a PowerShell script for `powershell.exe -EncodedCommand` (UTF-16LE). */
export function encodePowerShellCommand(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Parse the probe's stdout JSON into the public result shape, or null when the
 * output is malformed or incomplete.
 */
export function parseProbeOutput(stdout) {
  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  // 指定了任务栏句柄却没能拿到它的 UIA 元素时，不能把“零个按钮”当成
  // 一个巨大的空档；直接返回 null，让调用方走托盘左侧兜底。
  if (data.taskbarFound === false) return null;
  if (!Array.isArray(data.buttons)) return null;
  if (!isFiniteNumber(data.osBuild)) return null;

  const buttons = [];
  for (const button of data.buttons) {
    if (!button || typeof button !== 'object') return null;
    if (
      !isFiniteNumber(button.x) ||
      !isFiniteNumber(button.y) ||
      !isFiniteNumber(button.w) ||
      !isFiniteNumber(button.h)
    ) {
      return null;
    }
    buttons.push({
      x: Math.trunc(button.x),
      y: Math.trunc(button.y),
      w: Math.trunc(button.w),
      h: Math.trunc(button.h),
    });
  }

  const taskbarAl = isFiniteNumber(data.taskbarAl) ? data.taskbarAl : null;
  const lightTaskbar =
    data.lightTaskbar === null || data.lightTaskbar === undefined ? null : data.lightTaskbar === 1;

  return { buttons, taskbarAl, lightTaskbar, osBuild: Math.trunc(data.osBuild) };
}

function resolvePowerShellPath() {
  const systemRoot = process.env.SystemRoot || process.env.windir;
  if (!systemRoot) return null;
  return path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/**
 * Run the probe on this machine. Resolves to the parsed result, or null on
 * non-Windows platforms, a missing powershell.exe, a spawn/timeout error, a
 * non-zero exit, or unparseable output.
 */
export function probeTaskbar({ taskbarHwnd = 0, timeoutMs = 10000 } = {}) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      resolve(null);
      return;
    }

    const powershell = resolvePowerShellPath();
    if (!powershell || !existsSync(powershell)) {
      resolve(null);
      return;
    }

    execFile(
      powershell,
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        encodePowerShellCommand(buildProbeScript(taskbarHwnd)),
      ],
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        resolve(parseProbeOutput(stdout));
      }
    );
  });
}
