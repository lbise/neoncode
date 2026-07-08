using System.IO;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Threading;
using NeonCode.Windows.Configuration;
using NeonCode.Windows.Terminal;

namespace NeonCode.ElectronTerminalHost;

public partial class MainWindow : Window
{
    private const string SessionId = "electron-spike-shell";

    private readonly HostOptions options;
    private readonly JsonSerializerOptions jsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    private readonly WindowsTerminalView terminalView;
    private readonly DispatcherTimer embedTimer;
    private ClientWebSocket? socket;
    private CancellationTokenSource? receiveCts;
    private nint ownHwnd;
    private bool parentWasMinimized;
    private bool started;

    public MainWindow(HostOptions options)
    {
        this.options = options;
        InitializeComponent();

        var config = AppConfig.LoadOrCreateDefault();
        terminalView = new WindowsTerminalView(config.Terminal);
        terminalView.Input += async bytes => await SendInputAsync(bytes);
        terminalView.Resized += async (columns, rows) => await SendResizeAsync(columns, rows);
        Root.Children.Add(terminalView.Element);

        SourceInitialized += OnSourceInitialized;
        Loaded += async (_, _) => await ConnectAndStartAsync();
        Activated += (_, _) => FocusTerminal();
        StateChanged += (_, _) =>
        {
            if (WindowState != WindowState.Minimized)
            {
                FitIntoParent();
                FocusTerminal();
            }
        };
        Closed += async (_, _) => await DisconnectAsync();

        embedTimer = new DispatcherTimer
        {
            Interval = TimeSpan.FromMilliseconds(33),
        };
        embedTimer.Tick += (_, _) => PollParentWindow();
        StartControlCommandLoop();
    }

    private void StartControlCommandLoop()
    {
        _ = Task.Run(async () =>
        {
            try
            {
                using var input = Console.OpenStandardInput();
                using var reader = new StreamReader(input, Encoding.UTF8);

                while (await reader.ReadLineAsync() is { } line)
                {
                    if (line.StartsWith("focus", StringComparison.OrdinalIgnoreCase))
                    {
                        await Dispatcher.InvokeAsync(ForceRestoreRefresh, DispatcherPriority.Send);
                    }
                }
            }
            catch
            {
                // Control pipe is best-effort for the spike.
            }
        });
    }

    private void OnSourceInitialized(object? sender, EventArgs e)
    {
        ownHwnd = new WindowInteropHelper(this).Handle;

        if (options.ParentHwnd == 0)
        {
            return;
        }

        var style = NativeWindow.GetWindowLongPtr(ownHwnd, NativeWindow.GwlStyle).ToInt64();
        style &= ~NativeWindow.WsPopup;
        style &= ~NativeWindow.WsCaption;
        style &= ~NativeWindow.WsThickFrame;
        style &= ~NativeWindow.WsSysMenu;
        style &= ~NativeWindow.WsMinimizeBox;
        style &= ~NativeWindow.WsMaximizeBox;
        style |= NativeWindow.WsChild | NativeWindow.WsVisible;

        NativeWindow.SetWindowLongPtr(ownHwnd, NativeWindow.GwlStyle, (nint)style);
        NativeWindow.SetParent(ownHwnd, options.ParentHwnd);
        NativeWindow.ShowWindow(ownHwnd, NativeWindow.SwShow);
        FitIntoParent();
        embedTimer.Start();
    }

    private void PollParentWindow()
    {
        if (options.ParentHwnd == 0 || ownHwnd == 0)
        {
            return;
        }

        var parentIsMinimized = NativeWindow.IsIconic(options.ParentHwnd);
        if (parentWasMinimized && !parentIsMinimized)
        {
            ForceRestoreRefresh();
        }

        parentWasMinimized = parentIsMinimized;

        if (!parentIsMinimized)
        {
            FitIntoParent();
        }
    }

    private void FitIntoParent()
    {
        if (options.ParentHwnd == 0 || ownHwnd == 0)
        {
            return;
        }

        if (!NativeWindow.GetClientRect(options.ParentHwnd, out var rect))
        {
            return;
        }

        var top = Math.Clamp(options.TopOffset, 0, Math.Max(0, rect.Height - 1));
        NativeWindow.ShowWindow(ownHwnd, NativeWindow.SwShow);
        NativeWindow.SetWindowPos(ownHwnd, NativeWindow.HwndTop, 0, top, Math.Max(1, rect.Width), Math.Max(1, rect.Height - top), NativeWindow.SwpShowWindow);
        NativeWindow.RedrawWindow(ownHwnd, 0, 0, NativeWindow.RdwInvalidate | NativeWindow.RdwAllChildren | NativeWindow.RdwUpdateNow);
    }

    private void ForceRestoreRefresh()
    {
        if (options.ParentHwnd != 0 && ownHwnd != 0)
        {
            NativeWindow.SetParent(ownHwnd, options.ParentHwnd);
            NativeWindow.ShowWindow(ownHwnd, NativeWindow.SwRestore);
            FitIntoParent();
        }

        terminalView.Element.InvalidateVisual();
        terminalView.Element.UpdateLayout();
        FocusTerminal();
    }

    private bool IsParentForeground()
    {
        if (options.ParentHwnd == 0)
        {
            return true;
        }

        var foreground = NativeWindow.GetForegroundWindow();
        if (foreground == 0)
        {
            return false;
        }

        if (foreground == options.ParentHwnd || foreground == ownHwnd)
        {
            return true;
        }

        return NativeWindow.GetAncestor(foreground, NativeWindow.GaRoot) == options.ParentHwnd;
    }

    private void ForceActivationFocus()
    {
        FitIntoParent();

        if (!IsParentForeground())
        {
            return;
        }

        if (ownHwnd != 0)
        {
            var currentThread = NativeWindow.GetCurrentThreadId();
            var parentThread = options.ParentHwnd != 0
                ? NativeWindow.GetWindowThreadProcessId(options.ParentHwnd, out _)
                : 0;
            var foreground = NativeWindow.GetForegroundWindow();
            var foregroundThread = foreground != 0
                ? NativeWindow.GetWindowThreadProcessId(foreground, out _)
                : 0;

            if (parentThread != 0 && parentThread != currentThread)
            {
                NativeWindow.AttachThreadInput(currentThread, parentThread, attach: true);
            }

            if (foregroundThread != 0 && foregroundThread != currentThread && foregroundThread != parentThread)
            {
                NativeWindow.AttachThreadInput(currentThread, foregroundThread, attach: true);
            }

            try
            {
                NativeWindow.BringWindowToTop(ownHwnd);
                NativeWindow.SetActiveWindow(ownHwnd);
                NativeWindow.SetFocus(ownHwnd);
            }
            finally
            {
                if (foregroundThread != 0 && foregroundThread != currentThread && foregroundThread != parentThread)
                {
                    NativeWindow.AttachThreadInput(currentThread, foregroundThread, attach: false);
                }

                if (parentThread != 0 && parentThread != currentThread)
                {
                    NativeWindow.AttachThreadInput(currentThread, parentThread, attach: false);
                }
            }
        }

        terminalView.Focus();
    }

    private void FocusTerminal()
    {
        ForceActivationFocus();
    }

    private async Task ConnectAndStartAsync()
    {
        socket = new ClientWebSocket();
        receiveCts = new CancellationTokenSource();
        await socket.ConnectAsync(new Uri(options.Endpoint), receiveCts.Token);
        _ = ReceiveLoopAsync(socket, receiveCts.Token);

        started = true;
        await SendAsync(new
        {
            type = "start",
            session_id = SessionId,
            command = options.Command,
            rows = 30,
            cols = 120,
        });

        FocusTerminal();
    }

    private async Task SendInputAsync(byte[] bytes)
    {
        if (!started)
        {
            return;
        }

        await SendAsync(new
        {
            type = "input",
            session_id = SessionId,
            data_b64 = Convert.ToBase64String(bytes),
        });
    }

    private async Task SendResizeAsync(uint columns, uint rows)
    {
        if (!started)
        {
            return;
        }

        await SendAsync(new
        {
            type = "resize",
            session_id = SessionId,
            rows,
            cols = columns,
        });
    }

    private async Task SendAsync(object message)
    {
        if (socket is not { State: WebSocketState.Open })
        {
            return;
        }

        var json = JsonSerializer.Serialize(message, jsonOptions);
        var bytes = Encoding.UTF8.GetBytes(json);
        await socket.SendAsync(bytes, WebSocketMessageType.Text, true, CancellationToken.None);
    }

    private async Task ReceiveLoopAsync(ClientWebSocket activeSocket, CancellationToken cancellationToken)
    {
        var buffer = new byte[64 * 1024];
        var builder = new MemoryStream();

        try
        {
            while (activeSocket.State == WebSocketState.Open && !cancellationToken.IsCancellationRequested)
            {
                builder.SetLength(0);
                WebSocketReceiveResult result;
                do
                {
                    result = await activeSocket.ReceiveAsync(buffer, cancellationToken);
                    if (result.MessageType == WebSocketMessageType.Close)
                    {
                        return;
                    }

                    builder.Write(buffer, 0, result.Count);
                } while (!result.EndOfMessage);

                if (result.MessageType != WebSocketMessageType.Text)
                {
                    continue;
                }

                HandleServerMessage(Encoding.UTF8.GetString(builder.ToArray()));
            }
        }
        catch (OperationCanceledException)
        {
            // Expected on shutdown.
        }
    }

    private void HandleServerMessage(string json)
    {
        using var document = JsonDocument.Parse(json);
        var root = document.RootElement;
        var type = root.GetProperty("type").GetString();

        switch (type)
        {
            case "started":
                terminalView.Write(Encoding.UTF8.GetBytes("\r\n[electron spike session started]\r\n"));
                break;
            case "output":
                var dataB64 = root.GetProperty("data_b64").GetString() ?? string.Empty;
                terminalView.Write(Convert.FromBase64String(dataB64));
                break;
            case "exit":
                started = false;
                terminalView.Write(Encoding.UTF8.GetBytes("\r\n[electron spike session exited]\r\n"));
                break;
            case "error":
                var message = root.TryGetProperty("message", out var messageElement)
                    ? messageElement.GetString()
                    : "unknown error";
                terminalView.Write(Encoding.UTF8.GetBytes($"\r\n[error] {message}\r\n"));
                break;
        }
    }

    private async Task DisconnectAsync()
    {
        try
        {
            embedTimer.Stop();
            receiveCts?.Cancel();
            if (socket is { State: WebSocketState.Open })
            {
                await socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "terminal host shutdown", CancellationToken.None);
            }
        }
        catch
        {
            // Best-effort shutdown for spike.
        }
        finally
        {
            socket?.Dispose();
            receiveCts?.Dispose();
        }
    }
}
