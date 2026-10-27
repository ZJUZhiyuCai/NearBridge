using System.IO.Compression;

namespace NearBridge;

internal static class SelfTest
{
    internal static async Task ClientTest(string directory, string url)
    {
        using (var first = new BridgeClient(directory, new Uri(url)))
        {
            try { await first.SendAction("text", "Windows ↔ 鸿蒙 🌉"); throw new Exception("Expected a lost reply"); }
            catch (HttpRequestException) { }
            if (!first.HasPending) throw new Exception("Lost reply must retain ID");
        }
        using var restarted = new BridgeClient(directory, new Uri(url));
        await restarted.RetryAction();
        if (restarted.HasPending) throw new Exception("Receipt must clear journal");
        var file = Path.Combine(directory, "测试.bin");
        File.WriteAllBytes(file, Enumerable.Range(0, 12000).Select(x => (byte)(x % 251)).ToArray());
        try { await restarted.Enqueue([file]); throw new Exception("Expected a lost chunk reply"); }
        catch (HttpRequestException) { }
        using var resumed = new BridgeClient(directory, new Uri(url));
        await resumed.SendQueue();
        if (resumed.QueueCount != 0) throw new Exception("Verified upload must leave queue");
        Console.WriteLine("Windows actions and file queues survive lost replies and process restart.");
    }

    internal static void Run()
    {
        static void Check(bool condition, string message) { if (!condition) throw new Exception(message); }
        Check(BluetoothWire.ValidWrite([1, 1]), "open");
        Check(BluetoothWire.ValidWrite([3, 255, 42]), "data");
        foreach (var malformed in new byte[][] { [], [1], [1, 0], [1, 1, 0], [2, 1], [3, 1], [5, 1], new byte[513] })
            Check(!BluetoothWire.ValidWrite(malformed), "reject malformed");
        Check(!BluetoothWire.ValidWrite([1, 1], 1), "reject partial writes");
        var payload = Enumerable.Range(0, 32771).Select(x => (byte)(x % 251)).ToArray();
        foreach (var limit in new[] { 20, 64, 182, 512, 514 })
        {
            var frames = BluetoothWire.Frames(3, 7, payload, limit).ToArray();
            Check(frames.All(x => x.Length <= Math.Min(limit, 512) && BluetoothWire.ValidWrite(x)), "MTU limits");
            Check(frames.SelectMany(x => x.Skip(2)).SequenceEqual(payload), "TLS bytes preserved");
        }
        var directory = Path.Combine(Path.GetTempPath(), "nearbridge-native-" + Guid.NewGuid());
        Directory.CreateDirectory(directory);
        try
        {
            var source = Path.Combine(directory, "照片 中文"); Directory.CreateDirectory(source);
            Directory.CreateDirectory(Path.Combine(source, "空目录"));
            File.WriteAllBytes(Path.Combine(source, "文件.bin"), payload);
            var zip = Path.Combine(directory, "folder.zip"); BridgeClient.Stage(source, zip, true);
            using (var archive = ZipFile.OpenRead(zip))
            {
                Check(archive.GetEntry("空目录/") != null, "empty directories");
                using var reader = archive.GetEntry("文件.bin")!.Open();
                using var bytes = new MemoryStream(); reader.CopyTo(bytes);
                Check(bytes.ToArray().SequenceEqual(payload), "folder bytes");
            }
            var journal = Path.Combine(directory, "journal.json");
            BridgeClient.Save(journal, new { operation = "same-id", unicode = "你好 🌉" });
            Check(File.ReadAllText(journal).Contains("same-id"), "journal persisted");
            Check(!File.Exists(journal + ".tmp"), "journal atomically replaced");
            var native = Path.Combine(directory, "windows"); Directory.CreateDirectory(native);
            File.WriteAllText(Path.Combine(native, "pending-action.json"), "null");
            bool rejected = false;
            try { using var client = new BridgeClient(directory, new Uri("http://127.0.0.1:1/")); }
            catch (InvalidDataException) { rejected = true; }
            Check(rejected, "corrupt journal cannot mint a fresh ID");
            Console.WriteLine("Windows BLE framing, folder packaging and durable journal checks passed.");
        }
        finally { Directory.Delete(directory, true); }
    }
}
