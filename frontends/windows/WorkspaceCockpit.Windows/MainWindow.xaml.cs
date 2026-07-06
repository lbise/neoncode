using System.IO;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Windows;
using System.Windows.Input;

namespace WorkspaceCockpit.Windows;

public partial class MainWindow : Window
{
    private const string SessionId = "shell";

    private readonly JsonSerializerOptions jsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    private ClientWebSocket? socket;
    private CancellationTokenSource? receiveCts;

    public MainWindow()
    {
        InitializeComponent();
    }

    private async void ConnectButton_Click(object sender, RoutedEventArgs e)
    {
        if (socket is { State: WebSocketState.Open })
        {
            await DisconnectAsync();
            return;
        }

        try
        {
            SetStatus("Connecting...");
            socket = new ClientWebSocket();
            receiveCts = new CancellationTokenSource();
            await socket.ConnectAsync(new Uri(EndpointTextBox.Text), receiveCts.Token);

            ConnectButton.Content = "Disconnect";
            StartShellButton.IsEnabled = true;
            SetStatus("Connected");
            _ = ReceiveLoopAsync(socket, receiveCts.Token);
        }
        catch (Exception ex)
        {
            SetStatus($"Connect failed: {ex.Message}");
            socket?.Dispose();
            socket = null;
        }
    }

    private async void StartShellButton_Click(object sender, RoutedEventArgs e)
    {
        await SendAsync(new
        {
            type = "start",
            session_id = SessionId,
            command = "bash",
            rows = 30,
            cols = 120
        });

        StartShellButton.IsEnabled = false;
        SendButton.IsEnabled = true;
        InputTextBox.IsEnabled = true;
        InputTextBox.Focus();
    }

    private async void SendButton_Click(object sender, RoutedEventArgs e)
    {
        await SendInputAsync();
    }

    private async void InputTextBox_KeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key == Key.Enter)
        {
            e.Handled = true;
            await SendInputAsync();
        }
    }

    private void ClearButton_Click(object sender, RoutedEventArgs e)
    {
        TerminalOutputTextBox.Clear();
    }

    private async Task SendInputAsync()
    {
        var text = InputTextBox.Text;
        if (string.IsNullOrEmpty(text))
        {
            return;
        }

        InputTextBox.Clear();
        var bytes = Encoding.UTF8.GetBytes(text + "\n");
        await SendAsync(new
        {
            type = "input",
            session_id = SessionId,
            data_b64 = Convert.ToBase64String(bytes)
        });
    }

    private async Task SendAsync(object message)
    {
        if (socket is not { State: WebSocketState.Open })
        {
            SetStatus("Not connected");
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
                        SetStatus("Server closed connection");
                        return;
                    }
                    builder.Write(buffer, 0, result.Count);
                } while (!result.EndOfMessage);

                if (result.MessageType != WebSocketMessageType.Text)
                {
                    continue;
                }

                var json = Encoding.UTF8.GetString(builder.ToArray());
                HandleServerMessage(json);
            }
        }
        catch (OperationCanceledException)
        {
            // Expected on disconnect.
        }
        catch (Exception ex)
        {
            SetStatus($"Receive failed: {ex.Message}");
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
                AppendOutput("\r\n[session started]\r\n");
                break;
            case "output":
                var dataB64 = root.GetProperty("data_b64").GetString() ?? string.Empty;
                var bytes = Convert.FromBase64String(dataB64);
                AppendOutput(Encoding.UTF8.GetString(bytes));
                break;
            case "exit":
                AppendOutput("\r\n[session exited]\r\n");
                Dispatcher.Invoke(() =>
                {
                    SendButton.IsEnabled = false;
                    InputTextBox.IsEnabled = false;
                    StartShellButton.IsEnabled = true;
                });
                break;
            case "error":
                var message = root.TryGetProperty("message", out var messageElement)
                    ? messageElement.GetString()
                    : "unknown error";
                AppendOutput($"\r\n[error] {message}\r\n");
                break;
            default:
                AppendOutput($"\r\n[server] {json}\r\n");
                break;
        }
    }

    private void AppendOutput(string text)
    {
        Dispatcher.Invoke(() =>
        {
            TerminalOutputTextBox.AppendText(text.Replace("\n", "\r\n"));
            TerminalOutputTextBox.ScrollToEnd();
        });
    }

    private void SetStatus(string status)
    {
        Dispatcher.Invoke(() => StatusTextBlock.Text = status);
    }

    private async Task DisconnectAsync()
    {
        try
        {
            receiveCts?.Cancel();
            if (socket is { State: WebSocketState.Open })
            {
                await socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "client disconnect", CancellationToken.None);
            }
        }
        catch
        {
            // Best-effort disconnect.
        }
        finally
        {
            socket?.Dispose();
            socket = null;
            receiveCts?.Dispose();
            receiveCts = null;

            ConnectButton.Content = "Connect";
            StartShellButton.IsEnabled = false;
            SendButton.IsEnabled = false;
            InputTextBox.IsEnabled = false;
            SetStatus("Disconnected");
        }
    }

    protected override async void OnClosed(EventArgs e)
    {
        await DisconnectAsync();
        base.OnClosed(e);
    }
}
