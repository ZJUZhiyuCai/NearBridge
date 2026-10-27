using System.Diagnostics;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace NearBridge;

internal sealed class BridgeWindow : Form
{
    readonly WebView2 web = new() { Dock = DockStyle.Fill };
    readonly NotifyIcon tray = new() { Icon = SystemIcons.Application, Text = "NearBridge", Visible = true };
    readonly ToolStrip toolbar = new() { GripStyle = ToolStripGripStyle.Hidden, Dock = DockStyle.Top };
    readonly ToolStripLabel status = new("正在启动本地服务…");
    readonly CancellationTokenSource lifetime = new();
    readonly string[] initialFiles;
    BridgeClient? client;
    BluetoothBridge? bluetooth;
    Process? service;
    StreamWriter? log;
    bool exiting, ready, bluetoothEnabled;
    string bluetoothMessage = "蓝牙未开启";
    readonly ToolStripButton bluetoothButton = new("开启蓝牙");
    readonly ToolStripButton retryButton = new("重试队列 / 确认");

    internal BridgeWindow(string[] files)
    {
        initialFiles = files;
        Text = "NearBridge";
        Size = new Size(1100, 820); MinimumSize = new Size(780, 620);
        StartPosition = FormStartPosition.CenterScreen;
        Icon = SystemIcons.Application;
        Controls.Add(web); Controls.Add(toolbar);
        AddButton("选择文件", ChooseFiles);
        AddButton("发送文件夹", ChooseFolder);
        AddButton("发送剪贴板", async () => { if (client != null) await client.SendAction("text", Clipboard.GetText()); });
        toolbar.Items.Add(bluetoothButton);
        bluetoothButton.Click += async (_, _) => await Guard(ToggleBluetooth);
        toolbar.Items.Add(retryButton);
        retryButton.Click += async (_, _) => await Guard(Retry);
        AddButton("结束重试", Forget);
        AddButton("快捷方式目录", () => { OpenWorkflows(); return Task.CompletedTask; });
        toolbar.Items.Add(status);
        var menu = new ContextMenuStrip();
        menu.Items.Add("打开 NearBridge", null, (_, _) => ShowWindow());
        menu.Items.Add("发送文件…", null, async (_, _) => await Guard(ChooseFiles));
        menu.Items.Add("打开收件目录", null, async (_, _) => await Guard(async () => { if (client != null) await client.Post("api/mac/inbox"); }));
        menu.Items.Add("查看日志", null, (_, _) => OpenPath(Path.Combine(Program.DataDirectory, "windows-app.log")));
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("退出 NearBridge", null, async (_, _) => await Exit());
        tray.ContextMenuStrip = menu; tray.DoubleClick += (_, _) => ShowWindow();
        Shown += async (_, _) => await Guard(Start);
        FormClosing += (_, e) => { if (!exiting) { e.Cancel = true; Hide(); tray.ShowBalloonTip(2000, "NearBridge", "仍在托盘运行。右键托盘图标可退出。", ToolTipIcon.Info); } };
    }

    void AddButton(string title, Func<Task> action)
    {
        var button = new ToolStripButton(title);
        button.Click += async (_, _) => await Guard(action);
        toolbar.Items.Add(button);
    }
    async Task Guard(Func<Task> action)
    {
        try { await action(); }
        catch (Exception error)
        {
            WriteLog(error.ToString());
            status.Text = "操作未完成";
            if (web.CoreWebView2 != null) Emit(new { type = "error", message = error.Message });
            else MessageBox.Show(this, error.Message, "NearBridge", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            client?.Report();
        }
    }
    void WriteLog(string text) { lock (this) { log?.WriteLine($"{DateTimeOffset.Now:O} {text}"); log?.Flush(); } }
    void ShowWindow() { Show(); WindowState = FormWindowState.Normal; Activate(); }
    static void OpenPath(string path) => Process.Start(new ProcessStartInfo(path) { UseShellExecute = true });
    void OpenWorkflows()
    {
        var directory = Path.Combine(Program.DataDirectory, "Workflows");
        Directory.CreateDirectory(directory); OpenPath(directory);
    }

    async Task Start()
    {
        Directory.CreateDirectory(Program.DataDirectory);
        log = new StreamWriter(Path.Combine(Program.DataDirectory, "windows-app.log"), true, new UTF8Encoding(false)) { AutoFlush = true };
        var port = Port("NEARBRIDGE_PORT", 53318);
        var nativePort = Port("NEARBRIDGE_NATIVE_PORT", 53320);
        if (port == nativePort) throw new InvalidOperationException("管理端口与手机端口不能相同");
        client = new BridgeClient(Program.DataDirectory, new Uri($"http://127.0.0.1:{port}/"));
        client.Changed += Emit;
        bluetooth = new BluetoothBridge(nativePort);
        bluetooth.Status += (message, enabled) => UI(() => { bluetoothEnabled = enabled; bluetoothMessage = message; bluetoothButton.Text = enabled ? "关闭蓝牙" : "开启蓝牙"; status.Text = message; Emit(new { type = "bluetooth", message, enabled }); });
        if (!await Healthy())
        {
            var root = Path.Combine(AppContext.BaseDirectory, "bridge");
            var node = Path.Combine(AppContext.BaseDirectory, "node.exe");
            if (!File.Exists(node) || !File.Exists(Path.Combine(root, "src", "main.mjs")))
                throw new FileNotFoundException("客户端文件不完整，请先运行 npm run build:windows。");
            var start = new ProcessStartInfo(node) {
                WorkingDirectory = root, UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardOutput = true, RedirectStandardError = true, RedirectStandardInput = true,
                StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8
            };
            start.ArgumentList.Add(Path.Combine(root, "src", "main.mjs"));
            start.Environment["NEARBRIDGE_DATA_DIR"] = Program.DataDirectory;
            start.Environment["NEARBRIDGE_MANAGED"] = "1";
            service = new Process { StartInfo = start, EnableRaisingEvents = true };
            service.OutputDataReceived += (_, e) => { if (e.Data != null) WriteLog(e.Data); };
            service.ErrorDataReceived += (_, e) => { if (e.Data != null) WriteLog(e.Data); };
            service.Start(); service.BeginOutputReadLine(); service.BeginErrorReadLine();
            for (int attempt = 0; attempt < 60; attempt++)
            {
                if (service.HasExited) throw new IOException("本地服务启动失败，请查看托盘菜单中的日志（检查 OpenSSL 与端口）。");
                if (await Healthy()) break;
                await Task.Delay(500);
            }
            if (!await Healthy()) throw new IOException("本地服务启动超时，请查看日志");
        }
        var environment = await CoreWebView2Environment.CreateAsync(null, Path.Combine(Program.DataDirectory, "WebView2"));
        await web.EnsureCoreWebView2Async(environment);
        var core = web.CoreWebView2;
        core.Settings.AreDevToolsEnabled = false;
        core.Settings.AreHostObjectsAllowed = false;
        core.Settings.IsStatusBarEnabled = false;
        core.Settings.AreDefaultContextMenusEnabled = false;
        core.NavigationStarting += (_, e) => { if (!Trusted(e.Uri)) e.Cancel = true; };
        core.FrameNavigationStarting += (_, e) => e.Cancel = true;
        core.NewWindowRequested += (_, e) => e.Handled = true;
        core.PermissionRequested += (_, e) => e.State = CoreWebView2PermissionState.Deny;
        core.WebMessageReceived += async (_, e) => {
            if (!Trusted(e.Source)) return;
            await Guard(async () => {
                var data = JsonNode.Parse(e.WebMessageAsJson) as JsonObject;
                if (data?["type"]?.ToString() == "files")
                    await client.Enqueue(e.AdditionalObjects.OfType<CoreWebView2File>().Select(file => file.Path).Take(100));
                else await HandleMessage(data);
            });
        };
        await core.AddScriptToExecuteOnDocumentCreatedAsync("window.nearBridgeWindows = true;");
        core.NavigationCompleted += (_, e) => {
            ready = e.IsSuccess;
            // The web workspace owns the normal controls. Retain the native
            // toolbar as a recovery surface if WebView2 cannot load the page.
            toolbar.Visible = !ready;
            if (ready) { ReportHost(); client.Report(); }
        };
        core.Navigate(client.BaseUri.AbsoluteUri);
        if (!RegisterHotKey(Handle, 1, 0x4003, 0x20)) WriteLog("Ctrl+Alt+Space 已被其他程序使用，可从托盘打开");
        _ = ListenPipe();
        status.Text = "本机已就绪";
        if (initialFiles.Length > 0) await client.Enqueue(initialFiles);
        else if (client.QueueCount > 0) await client.SendQueue();
    }
    static int Port(string name, int fallback) => int.TryParse(Environment.GetEnvironmentVariable(name), out var port) && port is >= 1 and <= 65535 ? port : fallback;
    bool Trusted(string value) => client != null && Uri.TryCreate(value, UriKind.Absolute, out var uri) &&
        uri.GetLeftPart(UriPartial.Authority) == client.BaseUri.GetLeftPart(UriPartial.Authority) && uri.AbsolutePath == "/";
    async Task<bool> Healthy()
    {
        try
        {
            using var cancel = new CancellationTokenSource(1000);
            using var response = await client!.Http.GetAsync("health", cancel.Token);
            var data = JsonNode.Parse(await response.Content.ReadAsStringAsync(cancel.Token));
            return response.IsSuccessStatusCode && data?["app"]?.ToString() == "NearBridge";
        }
        catch { return false; }
    }
    async Task HandleMessage(JsonObject? data)
    {
        if (client == null || data == null) return;
        switch (data["type"]?.ToString())
        {
            case "chooseFiles": await ChooseFiles(); break;
            case "chooseFolder": await ChooseFolder(); break;
            case "text": await client.SendAction("text", data["text"]?.ToString() ?? ""); break;
            case "clipboard": await client.SendAction("text", Clipboard.GetText()); break;
            case "workflow": await client.SendAction("workflow", data["id"]?.ToString() ?? ""); break;
            case "retry": await Retry(); break;
            // The trusted workspace confirms before issuing this command.
            // The native fallback toolbar keeps its own confirmation dialog.
            case "forget": await client.ForgetAction(); break;
            case "openWorkflows": OpenWorkflows(); break;
            case "bluetooth":
                if (data["enabled"] is JsonValue value && value.TryGetValue<bool>(out var enabled) && enabled != bluetoothEnabled)
                    await ToggleBluetooth();
                else ReportHost();
                break;
            case "status": ReportHost(); client.Report(); break;
        }
    }
    void ReportHost()
    {
        Emit(new { type = "host", actions = new[] { "bluetooth", "forget", "openWorkflows" } });
        Emit(new { type = "bluetooth", message = bluetoothMessage, enabled = bluetoothEnabled });
    }
    Task ChooseFiles()
    {
        if (client == null) return Task.CompletedTask;
        using var picker = new OpenFileDialog { Multiselect = true, Title = "发送到鸿蒙手机" };
        return picker.ShowDialog(this) == DialogResult.OK ? client.Enqueue(picker.FileNames) : Task.CompletedTask;
    }
    Task ChooseFolder()
    {
        if (client == null) return Task.CompletedTask;
        using var picker = new FolderBrowserDialog { Description = "将文件夹打包为 ZIP 后发送", UseDescriptionForTitle = true };
        return picker.ShowDialog(this) == DialogResult.OK ? client.Enqueue([picker.SelectedPath]) : Task.CompletedTask;
    }
    async Task Retry()
    {
        if (client == null) return;
        if (client.HasPending) await client.RetryAction();
        await client.SendQueue();
    }
    async Task Forget()
    {
        if (client?.HasPending == true && MessageBox.Show(this, "这不会撤销已执行的操作。请先检查结果；结束后再次点按会创建新操作。", "结束重试？", MessageBoxButtons.OKCancel, MessageBoxIcon.Warning) == DialogResult.OK)
            await client.ForgetAction();
    }
    async Task ToggleBluetooth()
    {
        if (bluetooth == null || !bluetoothButton.Enabled) return;
        bluetoothButton.Enabled = false;
        try { if (bluetoothEnabled) await bluetooth.Stop(); else await bluetooth.Start(); }
        finally { bluetoothButton.Enabled = true; }
    }
    void UI(Action action) { if (!IsDisposed && IsHandleCreated) { if (InvokeRequired) BeginInvoke(action); else action(); } }
    void Emit(object message) => UI(() => {
        if (message is not null && ready) web.CoreWebView2?.PostWebMessageAsJson(JsonSerializer.Serialize(message));
        if (client != null) retryButton.Text = client.HasPending ? "重试确认" : $"重试队列 ({client.QueueCount})";
    });
    async Task ListenPipe()
    {
        while (!lifetime.IsCancellationRequested)
        {
            try
            {
                await using var pipe = new NamedPipeServerStream(Program.PipeName, PipeDirection.In, 1, PipeTransmissionMode.Byte,
                    PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
                await pipe.WaitForConnectionAsync(lifetime.Token);
                using var reader = new StreamReader(pipe);
                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token); timeout.CancelAfter(5000);
                var line = await reader.ReadLineAsync(timeout.Token);
                if (line == null || line.Length > 65536) continue;
                var paths = JsonSerializer.Deserialize<string[]>(line) ?? [];
                if (paths.Length > 100) continue;
                if (paths.Length == 1 && paths[0] == "--quit") { await Exit(); return; }
                ShowWindow();
                if (client != null && paths.Length > 0) await Guard(() => client.Enqueue(paths));
            }
            catch (OperationCanceledException) { }
            catch (Exception error) { WriteLog(error.Message); }
        }
    }
    async Task Exit()
    {
        if (exiting) return; exiting = true;
        lifetime.Cancel(); UnregisterHotKey(Handle, 1);
        if (bluetooth != null) await bluetooth.DisposeAsync();
        if (service is { HasExited: false })
        {
            try { await service.StandardInput.WriteLineAsync("shutdown"); await service.StandardInput.FlushAsync(); await service.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(5)); }
            catch { if (!service.HasExited) service.Kill(true); }
        }
        client?.Dispose(); tray.Visible = false; tray.Dispose(); log?.Dispose(); Close();
    }
    protected override void WndProc(ref Message m) { if (m.Msg == 0x0312) ShowWindow(); base.WndProc(ref m); }
    [DllImport("user32.dll")] static extern bool RegisterHotKey(IntPtr hwnd, int id, uint modifiers, uint key);
    [DllImport("user32.dll")] static extern bool UnregisterHotKey(IntPtr hwnd, int id);
}
