using System.IO.Pipes;
using System.Text.Json;

namespace NearBridge;

internal static class Program
{
    // Per-user pipe and mutex keep Explorer's Send To invocations in one window.
    internal static readonly string UserKey = System.Security.Principal.WindowsIdentity.GetCurrent().User!.Value.Replace('-', '_');
    internal static readonly string PipeName = "NearBridge_" + UserKey;
    internal static readonly string DataDirectory = Environment.GetEnvironmentVariable("NEARBRIDGE_DATA_DIR")
        ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "NearBridge");

    [STAThread]
    static void Main(string[] args)
    {
        if (args.Contains("--self-test")) { SelfTest.Run(); return; }
        if (args.Length == 3 && args[0] == "--client-test") { SelfTest.ClientTest(args[1], args[2]).GetAwaiter().GetResult(); return; }
        using var mutex = new Mutex(true, @"Local\" + PipeName, out var first);
        if (!first)
        {
            try
            {
                using var pipe = new NamedPipeClientStream(".", PipeName, PipeDirection.Out);
                pipe.Connect(5000);
                using var writer = new StreamWriter(pipe);
                writer.WriteLine(JsonSerializer.Serialize(args));
            }
            catch (Exception error) { MessageBox.Show("已有 NearBridge 正在启动，请稍后重试。\n" + error.Message); }
            return;
        }
        if (args.Length == 1 && args[0] == "--quit") return;
        ApplicationConfiguration.Initialize();
        Application.Run(new BridgeWindow(args));
        mutex.ReleaseMutex();
    }
}
