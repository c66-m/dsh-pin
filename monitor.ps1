param(
  [string]$Origin = 'http://127.0.0.1:6425'
)
$script:Origin = $Origin

Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Net.Http

Add-Type @'
using System;
using System.Runtime.InteropServices;
public class DshPinNative {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
'@
[DshPinNative]::SetProcessDPIAware() | Out-Null

# 点击穿透：WM_NCHITTEST 的 HTTRANSPARENT 只对同线程窗口生效，跨进程没用，
# 所以改用 WS_EX_TRANSPARENT 动态开关：定时轮询光标，落在按钮/标题栏上就恢复正常，
# 其余时刻整窗穿透，鼠标直接落到下面的程序。
Add-Type -ReferencedAssemblies PresentationFramework, PresentationCore, WindowsBase, System.Xaml -TypeDefinition @'
using System;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Runtime.InteropServices;

public class DshPinClickThrough {
  const int GWL_EXSTYLE = -20;
  const int WS_EX_TRANSPARENT = 0x00000020;
  const int WS_EX_LAYERED = 0x00080000;

  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int idx);
  [DllImport("user32.dll")] static extern int SetWindowLong(IntPtr h, int idx, int val);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
  [StructLayout(LayoutKind.Sequential)] struct POINT { public int X; public int Y; }

  static Window _win;
  static IntPtr _hwnd;
  static FrameworkElement _header;
  static bool? _last;

  static void Refresh() {
    if (_hwnd == IntPtr.Zero) return;
    SetWindowPos(_hwnd, IntPtr.Zero, 0, 0, 0, 0, 0x0027); // SWP_NOMOVE|NOSIZE|NOZORDER|FRAMECHANGED
  }

  [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr h, int msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern bool ReleaseCapture();
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);

  public static void Attach(Window w, FrameworkElement header) {
    _win = w;
    _header = header;
    _hwnd = new WindowInteropHelper(w).Handle;
    Update();
  }

  /// 标准窗口拖拽：ReleaseCapture + WM_NCLBUTTONDOWN(HTCAPTION)，比 WPF DragMove 可靠。
  public static void StartDrag() {
    if (_hwnd == IntPtr.Zero) return;
    int ex = GetWindowLong(_hwnd, GWL_EXSTYLE);
    SetWindowLong(_hwnd, GWL_EXSTYLE, ex & ~WS_EX_TRANSPARENT);
    _last = false;
    ReleaseCapture();
    SendMessage(_hwnd, 0x00A1, (IntPtr)2, IntPtr.Zero);
  }

  /// 光标在整窗内且在标题栏或按钮/滚动条上 → 可点；否则整窗穿透。
  public static void Update() {
    if (_win == null || _hwnd == IntPtr.Zero) return;
    bool interactive = false;
    try {
      POINT p;
      if (GetCursorPos(out p)) {
        var pt = _win.PointFromScreen(new Point(p.X, p.Y));
        if (pt.X >= 0 && pt.Y >= 0 && pt.X <= _win.ActualWidth && pt.Y <= _win.ActualHeight) {
          if (_header != null && pt.Y <= _header.ActualHeight + 4) {
            interactive = true;   // 整条标题栏都可拖动，不穿透
          } else {
            var hit = _win.InputHitTest(pt) as DependencyObject;
            int guard = 0;
            while (hit != null && guard++ < 128) {
              if (hit is Button || hit is ScrollBar) { interactive = true; break; }
              hit = VisualTreeHelper.GetParent(hit);
            }
          }
        }
      }
    } catch {}

    bool wantTransparent = !interactive;
    if (_last == wantTransparent) return;
    _last = wantTransparent;

    int ex = GetWindowLong(_hwnd, GWL_EXSTYLE);
    int next = wantTransparent
      ? (ex | WS_EX_TRANSPARENT | WS_EX_LAYERED)
      : (ex & ~WS_EX_TRANSPARENT);
    SetWindowLong(_hwnd, GWL_EXSTYLE, next);
    Refresh();
  }
}
'@

$xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="任务监控" Width="260" Height="38" WindowStyle="None"
        AllowsTransparency="True" Background="Transparent"
        ShowInTaskbar="False" Topmost="True" ResizeMode="NoResize"
        WindowStartupLocation="Manual" FontFamily="Microsoft YaHei UI">
  <Border x:Name="Shell" CornerRadius="10" Background="#1417181C" BorderBrush="#1AFFFFFF" BorderThickness="1">
    <Grid>
      <Grid.RowDefinitions>
        <RowDefinition x:Name="HeaderRow" Height="36"/>
        <RowDefinition x:Name="BodyRow" Height="0"/>
      </Grid.RowDefinitions>

      <Grid x:Name="Header" Grid.Row="0">
        <Grid.ColumnDefinitions>
          <ColumnDefinition Width="*"/>
          <ColumnDefinition Width="Auto"/>
        </Grid.ColumnDefinitions>
        <Grid x:Name="DragArea" Grid.Column="0" Background="Transparent">
          <StackPanel Orientation="Horizontal" VerticalAlignment="Center" Margin="10,0,0,0">
            <Ellipse x:Name="LiveDot" Width="7" Height="7" Fill="#34C97B" Margin="0,0,7,0"/>
            <TextBlock x:Name="TitleText" Text="任务监控" Foreground="#E8E8EA" FontSize="12" VerticalAlignment="Center"/>
            <Border Background="#20FFFFFF" CornerRadius="8" Padding="5,0" Margin="7,0,0,0" Height="16">
              <TextBlock x:Name="CountText" Text="0" Foreground="#B9BAC2" FontSize="10" VerticalAlignment="Center"/>
            </Border>
            <TextBlock x:Name="SummaryText" Text="暂无任务" Foreground="#8F9098" FontSize="10.5" Margin="8,0,0,0" VerticalAlignment="Center"/>
          </StackPanel>
        </Grid>
        <StackPanel Grid.Column="1" Orientation="Horizontal" VerticalAlignment="Center" Margin="0,0,5,0">
          <Button x:Name="ExpandButton" Width="24" Height="24" Margin="0,0,1,0" Background="Transparent" BorderThickness="0" Foreground="#8F9098" FontSize="12" ToolTip="展开">
            <TextBlock x:Name="ExpandGlyph" Text="＋"/>
          </Button>
          <Button x:Name="PinButton" Width="24" Height="24" Margin="0,0,1,0" Background="Transparent" BorderThickness="0" Foreground="#E0A400" FontSize="12" ToolTip="取消置顶">
            <TextBlock x:Name="PinGlyph" Text="📌"/>
          </Button>
          <Button x:Name="BackdropButton" Width="24" Height="24" Margin="0,0,1,0" BorderThickness="0" FontSize="12" ToolTip="切换背板">
            <TextBlock x:Name="BackdropGlyph" Text="◐"/>
          </Button>
          <Button x:Name="CloseButton" Width="24" Height="24" Background="Transparent" BorderThickness="0" Foreground="#8F9098" FontSize="14" ToolTip="关闭">
            <TextBlock x:Name="CloseGlyph" Text="×"/>
          </Button>
        </StackPanel>
      </Grid>

      <ScrollViewer x:Name="BodyScroll" Grid.Row="1" VerticalScrollBarVisibility="Auto" Visibility="Collapsed" Margin="5,0,5,2">
        <StackPanel x:Name="TaskList"/>
      </ScrollViewer>
    </Grid>
  </Border>
</Window>
'@

$window = [System.Windows.Markup.XamlReader]::Parse($xaml)
$dragArea = $window.FindName('DragArea')
$window.Add_MouseLeftButtonDown({ param($s,$e) if ($e.ButtonState -eq 'Pressed' -and $e.OriginalSource -ne $null -and $s -eq $window) { try { [DshPinClickThrough]::StartDrag() } catch {} } }) | Out-Null
$dragArea.Add_MouseLeftButtonDown({ param($s,$e) if ($e.ButtonState -eq 'Pressed') { try { [DshPinClickThrough]::StartDrag() } catch {} } }) | Out-Null
$window.FindName('Header').Add_MouseLeftButtonDown({ param($s,$e) if ($e.ButtonState -eq 'Pressed' -and $e.OriginalSource -is [System.Windows.Controls.TextBlock]) { try { [DshPinClickThrough]::StartDrag() } catch {} } }) | Out-Null

$headerRow = $window.FindName('HeaderRow')
$bodyRow = $window.FindName('BodyRow')
$bodyScroll = $window.FindName('BodyScroll')
$taskList = $window.FindName('TaskList')
$countText = $window.FindName('CountText')
$summaryText = $window.FindName('SummaryText')
$liveDot = $window.FindName('LiveDot')
$expandButton = $window.FindName('ExpandButton')
$expandGlyph = $window.FindName('ExpandGlyph')
$pinButton = $window.FindName('PinButton')
$pinGlyph = $window.FindName('PinGlyph')
$closeButton = $window.FindName('CloseButton')
$shell = $window.FindName('Shell')
$backdropButton = $window.FindName('BackdropButton')
$backdropGlyph = $window.FindName('BackdropGlyph')
$closeGlyph = $window.FindName('CloseGlyph')

$script:glyphPaths = @{}
$script:glyphTypeface = New-Object System.Windows.Media.Typeface('Microsoft YaHei UI')

# 文字没有 Stroke，转 Path 几何再分层画：黑描边层在下、彩色填充层在上，
# 硬边 1px，不会像高斯阴影那样糊成泛光。
function Set-GlyphText([string]$key, [string]$text) {
  $g = $script:glyphPaths[$key]
  if (-not $g) { return }
  $g.Text = $text
  $ft = New-Object System.Windows.Media.FormattedText($text, [System.Globalization.CultureInfo]::InvariantCulture, [System.Windows.FlowDirection]::LeftToRight, $script:glyphTypeface, $g.Size, [System.Windows.Media.Brushes]::Black, 1.0)
  $geo = $ft.BuildGeometry([System.Windows.Point]::new(0,0))
  $g.StrokePath.Data = $geo
  $g.FillPath.Data = $geo
}

function Set-GlyphFill([string]$key, [string]$color) {
  $g = $script:glyphPaths[$key]
  if ($g) { $g.FillPath.Fill = [System.Windows.Media.BrushConverter]::new().ConvertFromString($color) }
}

function Set-GlyphStroke([string]$key, [string]$color) {
  $g = $script:glyphPaths[$key]
  if ($g) {
    $brush = [System.Windows.Media.BrushConverter]::new().ConvertFromString($color)
    $g.StrokePath.Stroke = $brush
    $g.StrokePath.Fill = $brush
  }
}

function Add-GlyphPath([System.Windows.Controls.TextBlock]$tb, [string]$key) {
  $btn = $tb.Parent
  if (-not ($btn -is [System.Windows.Controls.Button])) { return }
  $grid = New-Object System.Windows.Controls.Grid
  $strokePath = New-Object System.Windows.Shapes.Path
  $strokePath.StrokeThickness = 0.8
  $strokePath.StrokeLineJoin = 'Round'
  $strokePath.Fill = [System.Windows.Media.Brushes]::Black
  $strokePath.Stroke = [System.Windows.Media.Brushes]::Black
  $strokePath.HorizontalAlignment = 'Center'
  $strokePath.VerticalAlignment = 'Center'
  $fillPath = New-Object System.Windows.Shapes.Path
  $fillPath.Fill = $tb.Foreground
  $fillPath.HorizontalAlignment = 'Center'
  $fillPath.VerticalAlignment = 'Center'
  $grid.Children.Add($strokePath) | Out-Null
  $grid.Children.Add($fillPath) | Out-Null
  $script:glyphPaths[$key] = @{ StrokePath = $strokePath; FillPath = $fillPath; Size = ($tb.FontSize + 4); Text = $tb.Text }
  Set-GlyphText $key $tb.Text
  $btn.Content = $grid
}

Add-GlyphPath $expandGlyph 'expand'
Add-GlyphPath $pinGlyph 'pin'
Add-GlyphPath $backdropGlyph 'backdrop'
Add-GlyphPath $closeGlyph 'close'

$script:expanded = $true
$script:anchorRight = 0
$script:tasks = @()
$script:lastPendingKey = ''

function Set-Expanded([bool]$value) {
  $script:expanded = $value
  if ($value) {
    $headerRow.Height = [System.Windows.GridLength]::new(36)
    $bodyRow.Height = [System.Windows.GridLength]::new(1, [System.Windows.GridUnitType]::Star)
    $bodyScroll.Visibility = 'Visible'
    $window.Width = 320
    $window.Height = 150
    Set-GlyphText 'expand' '－'
  } else {
    $headerRow.Height = [System.Windows.GridLength]::new(36)
    $bodyRow.Height = [System.Windows.GridLength]::new(0)
    $bodyScroll.Visibility = 'Collapsed'
    $window.Width = 260
    $window.Height = 38
    Set-GlyphText 'expand' '＋'
  }
  $window.Left = $script:anchorRight - $window.Width
}

function Post-Json([string]$path, [string]$json) {
  try {
    $content = New-Object System.Net.Http.StringContent($json, [System.Text.Encoding]::UTF8, 'application/json')
    $client = New-Object System.Net.Http.HttpClient
    [void]$client.PostAsync(($script:Origin + $path), $content).Result
  } catch {}
}

function Update-Tasks {
  try {
    $client = New-Object System.Net.Http.HttpClient
    $raw = $client.GetStringAsync(($script:Origin + '/dsh-pin-running/tasks')).Result
    $data = ConvertFrom-Json $raw
    $rows = @($data.rows)
  } catch {
    $rows = @()
  }
  $script:tasks = $rows
  $count = $rows.Count
  $countText.Text = [string]$count
  $pendingRows = @($rows | Where-Object { $_.pendingKind -or ($_.detail -match '^(等待回答|等待审批|计划待审)(\|.*)?$') })
  $pending = $pendingRows.Count
  $running = @($rows | Where-Object { $_.state -eq 'running' }).Count
  $interrupted = @($rows | Where-Object { $_.state -eq 'interrupted' }).Count
  if ($count -eq 0) { $summaryText.Text = '暂无任务' }
  elseif ($pending -gt 0) { $summaryText.Text = "待选择 $pending" }
  elseif ($running -gt 0) { $summaryText.Text = "运行中 $running" }
  elseif ($interrupted -gt 0) { $summaryText.Text = "中断 $interrupted" }
  else { $summaryText.Text = '已完成' }
  if ($pending -gt 0) { $liveDot.Fill = [System.Windows.Media.Brushes]::Orange }
  elseif ($running -gt 0) { $liveDot.Fill = [System.Windows.Media.Brushes]::LimeGreen }
  elseif ($interrupted -gt 0) { $liveDot.Fill = [System.Windows.Media.Brushes]::Goldenrod }
  else { $liveDot.Fill = [System.Windows.Media.Brushes]::Gray }
  $pendingKey = (($pendingRows | ForEach-Object { [string]$_.id + ':' + $(if ($_.pendingKind) { [string]$_.pendingKind } else { [string]$_.detail }) }) -join ',')
  if ($pending -gt 0 -and $pendingKey -ne $script:lastPendingKey) {
    $script:lastPendingKey = $pendingKey
    if (-not $script:expanded) { Set-Expanded $true }
    try { $window.Activate() } catch {}
  } elseif ($pending -eq 0) {
    $script:lastPendingKey = ''
  }

  $taskList.Children.Clear()
  foreach ($row in $rows) {
    $rowId = [string]$row.id
    $pendingKind = [string]$row.pendingKind
    $pendingText = [string]$row.pendingText
    if (-not $pendingKind -and $row.detail -match '^(等待回答|等待审批|计划待审)(\|.*)?$') {
      $pendingKind = switch ($Matches[1]) {
        '等待回答' { 'question' }
        '等待审批' { 'approval' }
        '计划待审' { 'plan-review' }
      }
      $pendingText = if ($row.detail -match '\|') { [string]($row.detail -replace '^[^|]*\|', '') } else { '' }
    }
    $isPending = $pendingKind -ne ''
    $border = New-Object System.Windows.Controls.Border
    $border.CornerRadius = [System.Windows.CornerRadius]::new(7)
    $border.Padding = [System.Windows.Thickness]::new(8, 4, 6, 4)
    $border.Margin = [System.Windows.Thickness]::new(4, 1, 4, 1)
    $border.Background = if ($isPending) { [System.Windows.Media.BrushConverter]::new().ConvertFromString('#28E0A400') } elseif ($row.current) { [System.Windows.Media.BrushConverter]::new().ConvertFromString('#246AA7FF') } else { [System.Windows.Media.Brushes]::Transparent }
    $border.Cursor = [System.Windows.Input.Cursors]::Hand

    $grid = New-Object System.Windows.Controls.Grid
    $colA = New-Object System.Windows.Controls.ColumnDefinition
    $colA.Width = [System.Windows.GridLength]::new(1, [System.Windows.GridUnitType]::Star)
    $colB = New-Object System.Windows.Controls.ColumnDefinition
    $colB.Width = [System.Windows.GridLength]::Auto
    $grid.ColumnDefinitions.Add($colA) | Out-Null
    $grid.ColumnDefinitions.Add($colB) | Out-Null

    $stack = New-Object System.Windows.Controls.StackPanel
    $line = New-Object System.Windows.Controls.StackPanel
    $line.Orientation = 'Horizontal'
    $dot = New-Object System.Windows.Shapes.Ellipse
    $dot.Width = 7; $dot.Height = 7; $dot.Margin = [System.Windows.Thickness]::new(0, 4, 7, 0)
    $dot.Fill = if ($isPending) { [System.Windows.Media.Brushes]::Orange } elseif ($row.state -eq 'interrupted') { [System.Windows.Media.Brushes]::Goldenrod } else { [System.Windows.Media.Brushes]::LimeGreen }
    $status = New-Object System.Windows.Controls.TextBlock
    $status.Text = if ($pendingKind -eq 'question') { '等待回答' } elseif ($pendingKind -eq 'plan-review') { '计划待审' } elseif ($pendingKind -eq 'approval') { '等待审批' } elseif ($row.state -eq 'interrupted') { '任务中断' } elseif ($row.state -eq 'completed') { '任务完成' } else { '任务进行中' }
    $status.Foreground = [System.Windows.Media.BrushConverter]::new().ConvertFromString($(if ($isPending) { '#E0A400' } elseif ($row.state -eq 'interrupted') { '#E0A400' } elseif ($row.state -eq 'completed') { '#8F9098' } else { '#34C97B' }))
    $status.FontSize = 9.5
    $status.Margin = [System.Windows.Thickness]::new(0, 1, 5, 0)
    $status.VerticalAlignment = 'Center'
    $title = New-Object System.Windows.Controls.TextBlock
    $title.Text = [string]$row.title
    $title.Foreground = [System.Windows.Media.BrushConverter]::new().ConvertFromString('#E8E8EA')
    $title.FontSize = 11.5
    $title.TextTrimming = 'CharacterEllipsis'
    $title.Width = if ($isPending -or $row.state -in @('interrupted', 'completed')) { 200 } else { 224 }
    $line.Children.Add($dot) | Out-Null
    $line.Children.Add($status) | Out-Null
    $line.Children.Add($title) | Out-Null
    $stack.Children.Add($line) | Out-Null
    if ($isPending -and $pendingText) {
      $prompt = New-Object System.Windows.Controls.TextBlock
      $prompt.Text = [string]$pendingText
      $prompt.Foreground = [System.Windows.Media.BrushConverter]::new().ConvertFromString('#E0A400')
      $prompt.FontSize = 9.5
      $prompt.TextTrimming = 'CharacterEllipsis'
      $prompt.Margin = [System.Windows.Thickness]::new(14, 0, 0, 0)
      $stack.Children.Add($prompt) | Out-Null
    }
    if ($row.state -notin @('running', 'completed', 'interrupted')) {
      $detail = New-Object System.Windows.Controls.TextBlock
      $detail.Text = [string]$row.detail
      $detail.Foreground = [System.Windows.Media.BrushConverter]::new().ConvertFromString('#8F9098')
      $detail.FontSize = 9.5
      $detail.Margin = [System.Windows.Thickness]::new(14, 0, 0, 0)
      $detail.TextTrimming = 'CharacterEllipsis'
      $stack.Children.Add($detail) | Out-Null
    }
    [System.Windows.Controls.Grid]::SetColumn($stack, 0)
    $grid.Children.Add($stack) | Out-Null

    if ($row.state -ne 'running') {
      $remove = New-Object System.Windows.Controls.Button
      $remove.Content = '×'
      $remove.Width = 18; $remove.Height = 18
      $remove.Padding = [System.Windows.Thickness]::new(0)
      $remove.Background = [System.Windows.Media.Brushes]::Transparent
      $remove.BorderThickness = [System.Windows.Thickness]::new(0)
      $remove.Foreground = [System.Windows.Media.BrushConverter]::new().ConvertFromString($(if ($row.state -eq 'interrupted') { '#E0A400' } else { '#8F9098' }))
      $remove.FontSize = 12
      $remove.ToolTip = '从置顶移除（不删除会话）'
      $remove.VerticalAlignment = 'Top'
      $remove.Margin = [System.Windows.Thickness]::new(2, 2, 0, 0)
      $remove.Add_Click({ param($s,$e) $e.Handled = $true; if ($s.Parent -and $s.Parent.Parent) { $s.Parent.Parent.Visibility = 'Collapsed' }; Post-Json '/dsh-pin-running/remove' (@{ id = $rowId } | ConvertTo-Json -Compress) }.GetNewClosure()) | Out-Null
      [System.Windows.Controls.Grid]::SetColumn($remove, 1)
      $grid.Children.Add($remove) | Out-Null
    }

    $border.Child = $grid
    $border.Add_MouseLeftButtonUp({ param($s,$e) Post-Json '/dsh-pin-running/focus' (@{ id = $rowId } | ConvertTo-Json -Compress) }.GetNewClosure()) | Out-Null
    $taskList.Children.Add($border) | Out-Null
  }
}

$script:transparent = $true

# 透明模式：面板几乎看不见，所以标题栏按钮自己带一块黑底，否则按钮图标在桌面上找不着。
function Set-Backdrop([bool]$transparent) {
  $script:transparent = $transparent
  if ($transparent) {
    $shell.Background = [System.Windows.Media.BrushConverter]::new().ConvertFromString('#1417181C')
    $shell.BorderBrush = [System.Windows.Media.BrushConverter]::new().ConvertFromString('#1AFFFFFF')
    foreach ($b in @($expandButton, $pinButton, $backdropButton, $closeButton)) {
      $b.Background = [System.Windows.Media.Brushes]::Transparent
      $b.BorderThickness = [System.Windows.Thickness]::new(0)
      $b.FocusVisualStyle = $null
    }
    Set-GlyphFill 'expand' '#FFFFFF'
    Set-GlyphFill 'pin' '#F0B400'
    Set-GlyphFill 'backdrop' '#FFFFFF'
    Set-GlyphFill 'close' '#FFFFFF'
    Set-GlyphStroke 'expand' '#000000'
    Set-GlyphStroke 'pin' '#000000'
    Set-GlyphStroke 'backdrop' '#000000'
    Set-GlyphStroke 'close' '#000000'
    Set-GlyphText 'backdrop' '◐'
    $backdropButton.ToolTip = '切换为实心背板'
  } else {
    $shell.Background = [System.Windows.Media.BrushConverter]::new().ConvertFromString('#F217181C')
    $shell.BorderBrush = [System.Windows.Media.BrushConverter]::new().ConvertFromString('#3A3B44')
    foreach ($b in @($expandButton, $pinButton, $backdropButton, $closeButton)) {
      $b.Background = [System.Windows.Media.Brushes]::Transparent
      $b.BorderThickness = [System.Windows.Thickness]::new(0)
    }
    Set-GlyphFill 'expand' '#8F9098'
    Set-GlyphFill 'pin' '#E0A400'
    Set-GlyphFill 'backdrop' '#8F9098'
    Set-GlyphFill 'close' '#8F9098'
    Set-GlyphStroke 'expand' '#00000000'
    Set-GlyphStroke 'pin' '#00000000'
    Set-GlyphStroke 'backdrop' '#00000000'
    Set-GlyphStroke 'close' '#00000000'
    Set-GlyphText 'backdrop' '◑'
    $backdropButton.ToolTip = '切换为透明背板'
  }
}

$backdropButton.Add_Click({ Set-Backdrop (-not $script:transparent) }) | Out-Null
$expandButton.Add_Click({ Set-Expanded (-not $script:expanded) }) | Out-Null
$pinButton.Add_Click({
  $window.Topmost = -not $window.Topmost
  $pinColor = if ($window.Topmost) { '#E0A400' } else { '#8F9098' }
  Set-GlyphFill 'pin' $pinColor
}) | Out-Null
$closeButton.Add_Click({ $window.Close() }) | Out-Null

$screen = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$script:anchorRight = $screen.Right - 16
$window.Left = $script:anchorRight - 320
$window.Top = $screen.Top + 16
Set-Expanded $true
Set-Backdrop $true

$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(900)
$timer.Add_Tick({ Update-Tasks })
$timer.Start()

Update-Tasks

# 句柄一就绪就装穿透开关：标题栏 + 按钮 / 滚动条可点，其余整窗穿透。
$window.Add_SourceInitialized({
  try { [DshPinClickThrough]::Attach($window, $window.FindName('Header')) } catch { }
}) | Out-Null

# 40ms 轮询光标位置，切换 WS_EX_TRANSPARENT；比 WM_NCHITTEST 可靠（跨进程有效）。
$passTimer = New-Object System.Windows.Threading.DispatcherTimer
$passTimer.Interval = [TimeSpan]::FromMilliseconds(25)
$passTimer.Add_Tick({ try { [DshPinClickThrough]::Update() } catch { } })
$window.Add_Loaded({ $passTimer.Start() }) | Out-Null
$window.Add_Closed({ $passTimer.Stop() }) | Out-Null

[void]$window.ShowDialog()
