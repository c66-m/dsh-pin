param(
  [string]$Title = '任务监控',
  [ValidateSet('init', 'compact', 'expand', 'topmost', 'normal', 'focus')]
  [string]$Action = 'init',
  [int]$Width = 260,
  [int]$Height = 36
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class DshPinWindow {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr hWnd, int X, int Y, int nWidth, int nHeight, bool bRepaint);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
  [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
'@

[DshPinWindow]::SetProcessDPIAware() | Out-Null

$script:monitorHandle = [IntPtr]::Zero
$callback = [DshPinWindow+EnumWindowsProc]{
  param($hWnd, $lParam)
  $buffer = New-Object System.Text.StringBuilder 512
  [void][DshPinWindow]::GetWindowText($hWnd, $buffer, 512)
  if ($buffer.ToString() -eq $Title) {
    $script:monitorHandle = $hWnd
    return $false
  }
  return $true
}
[void][DshPinWindow]::EnumWindows($callback, [IntPtr]::Zero)

if ($script:monitorHandle -eq [IntPtr]::Zero) { exit 1 }

[DshPinWindow]::ShowWindow($script:monitorHandle, 5) | Out-Null
[DshPinWindow]::ShowWindow($script:monitorHandle, 9) | Out-Null

# 去掉标题栏和边框，变成一条贴边的小条；同时从任务栏隐藏。
$style = [DshPinWindow]::GetWindowLong($script:monitorHandle, -16)
$style = $style -band (-bnot (0x00C00000 -bor 0x00040000 -bor 0x00020000 -bor 0x00010000 -bor 0x00080000))
[void][DshPinWindow]::SetWindowLong($script:monitorHandle, -16, $style)
$exStyle = [DshPinWindow]::GetWindowLong($script:monitorHandle, -20)
$exStyle = (($exStyle -bor 0x00000080) -band (-bnot 0x00040000))
[void][DshPinWindow]::SetWindowLong($script:monitorHandle, -20, $exStyle)

$work = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea

if ($Action -eq 'init' -or $Action -eq 'compact') {
  $Width = 260
  $Height = 36
  $x = $work.Right - $Width - 16
  $y = $work.Top + 16
  [DshPinWindow]::MoveWindow($script:monitorHandle, $x, $y, $Width, $Height, $true) | Out-Null
  [DshPinWindow]::SetWindowPos($script:monitorHandle, [IntPtr](-1), 0, 0, 0, 0, 0x0020 -bor 0x0004) | Out-Null
}
elseif ($Action -eq 'expand') {
  $Width = 320
  $Height = 400
  $x = $work.Right - $Width - 16
  $y = $work.Top + 16
  [DshPinWindow]::MoveWindow($script:monitorHandle, $x, $y, $Width, $Height, $true) | Out-Null
  [DshPinWindow]::SetWindowPos($script:monitorHandle, [IntPtr](-1), 0, 0, 0, 0, 0x0020 -bor 0x0004) | Out-Null
}
elseif ($Action -eq 'topmost') {
  [DshPinWindow]::SetWindowPos($script:monitorHandle, [IntPtr](-1), 0, 0, 0, 0, 0x0001 -bor 0x0002) | Out-Null
}
elseif ($Action -eq 'normal') {
  [DshPinWindow]::SetWindowPos($script:monitorHandle, [IntPtr](-2), 0, 0, 0, 0, 0x0001 -bor 0x0002) | Out-Null
}
elseif ($Action -eq 'focus') {
  [DshPinWindow]::SetForegroundWindow($script:monitorHandle) | Out-Null
}
