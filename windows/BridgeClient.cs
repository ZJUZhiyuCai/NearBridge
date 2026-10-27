using System.IO.Compression;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace NearBridge;

internal sealed record PendingAction(string Route, JsonObject Body);
internal sealed record OutgoingFile(string Id, string Name, string Path, long Size, string Hash);

internal sealed class BridgeClient : IDisposable
{
    internal readonly HttpClient Http;
    readonly string directory;
    readonly string actionFile;
    readonly string queueFile;
    readonly SemaphoreSlim actions = new(1, 1);
    readonly SemaphoreSlim uploads = new(1, 1);
    readonly List<OutgoingFile> queue;
    PendingAction? pending;
    internal event Action<object>? Changed;
    internal bool HasPending => pending != null;
    internal int QueueCount => queue.Count;
    internal Uri BaseUri { get; }

    internal BridgeClient(string dataDirectory, Uri baseUri)
    {
        BaseUri = baseUri;
        Http = new HttpClient { BaseAddress = baseUri, Timeout = TimeSpan.FromSeconds(40) };
        Http.DefaultRequestHeaders.Add("X-NearBridge", "1");
        Http.DefaultRequestHeaders.Add("Origin", baseUri.GetLeftPart(UriPartial.Authority));
        directory = Path.Combine(dataDirectory, "windows");
        Directory.CreateDirectory(Path.Combine(directory, "outgoing"));
        actionFile = Path.Combine(directory, "pending-action.json");
        queueFile = Path.Combine(directory, "outgoing.json");
        // Corrupt journals stop startup instead of silently losing operation IDs.
        pending = File.Exists(actionFile) ? JsonSerializer.Deserialize<PendingAction>(File.ReadAllText(actionFile))
            ?? throw new InvalidDataException("待确认操作损坏，请先检查上次执行结果并保留日志。") : null;
        queue = File.Exists(queueFile) ? JsonSerializer.Deserialize<List<OutgoingFile>>(File.ReadAllText(queueFile))
            ?? throw new InvalidDataException("无法读取待发队列，请保留数据并检查日志。") : [];
    }

    internal static void Save<T>(string file, T value)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(value);
        using (var stream = new FileStream(file + ".tmp", FileMode.Create, FileAccess.Write, FileShare.None))
        {
            stream.Write(bytes);
            stream.Flush(true);
        }
        File.Move(file + ".tmp", file, true);
    }

    internal async Task<JsonObject> ReadResponse(HttpResponseMessage response)
    {
        using (response)
        {
            var value = JsonNode.Parse(await response.Content.ReadAsStringAsync()) as JsonObject;
            if (!response.IsSuccessStatusCode) throw new HttpRequestException(value?["error"]?.ToString() ?? $"服务返回 {(int)response.StatusCode}");
            return value ?? throw new InvalidDataException("服务响应无效");
        }
    }
    internal async Task<JsonObject> Get(string route) => await ReadResponse(await Http.GetAsync(route));
    internal async Task<JsonObject> Post(string route, object? body = null) => await ReadResponse(await Http.PostAsJsonAsync(route, body ?? new { }));

    internal async Task SendAction(string kind, string value)
    {
        if (!await actions.WaitAsync(0)) throw new InvalidOperationException("上一项操作仍在确认");
        try
        {
            if (pending != null) throw new InvalidOperationException("上一项操作结果未确认，请先重试确认或结束重试。");
            if (kind == "text" && (string.IsNullOrWhiteSpace(value) || System.Text.Encoding.UTF8.GetByteCount(value) > 64 * 1024))
                throw new InvalidOperationException("请输入文字，且不超过 64 KB。");
            var state = await Get("api/state");
            if (state["capabilities"]?["reliableActions"]?.GetValue<int>() != 1)
                throw new InvalidOperationException("请先更新电脑本地服务到 0.6 或更高版本。");
            var body = new JsonObject {
                ["requestId"] = Guid.NewGuid().ToString(), ["requestedAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                ["peerId"] = state["device"]?["id"]?.GetValue<string>()
            };
            string route;
            if (kind == "text") { route = "api/actions/text"; body["text"] = value; }
            else if (kind == "workflow" && System.Text.RegularExpressions.Regex.IsMatch(value, @"^[a-zA-Z0-9-]{1,100}$"))
                route = $"api/actions/workflows/{value}/run";
            else throw new InvalidOperationException("操作无效");
            var next = new PendingAction(route, body);
            Save(actionFile, next);
            pending = next;
            await ConfirmPending();
        }
        finally { actions.Release(); Report(); }
    }
    async Task ConfirmPending()
    {
        if (pending == null) return;
        var action = pending;
        await Post(action.Route, action.Body);
        // Keep the ID if cleanup fails; confirmation can safely be repeated.
        File.Delete(actionFile);
        pending = null;
        Changed?.Invoke(new { type = "actionComplete", text = action.Body["text"]?.ToString() });
    }
    internal async Task RetryAction()
    {
        await actions.WaitAsync();
        try { await ConfirmPending(); }
        finally { actions.Release(); Report(); }
    }
    internal async Task ForgetAction()
    {
        await actions.WaitAsync();
        try { File.Delete(actionFile); pending = null; }
        finally { actions.Release(); Report(); }
    }
    internal void Report() => Changed?.Invoke(new { type = "queue", pending = HasPending, count = QueueCount });

    internal async Task Enqueue(IEnumerable<string> paths)
    {
        await uploads.WaitAsync();
        try
        {
            foreach (var source in paths)
            {
                if (queue.Count >= 100) throw new IOException("待发队列已满");
                var id = Guid.NewGuid().ToString();
                var destination = Path.Combine(directory, "outgoing", id);
                var folder = Directory.Exists(source);
                var name = Path.GetFileName(Path.TrimEndingDirectorySeparator(source)) + (folder ? ".zip" : "");
                try
                {
                    await Task.Run(() => Stage(source, destination, folder));
                    var size = new FileInfo(destination).Length;
                    if (size > 512L * 1024 * 1024 || queue.Sum(x => x.Size) + size > 2L * 1024 * 1024 * 1024)
                        throw new IOException("文件超过 512 MiB，或待发副本超过 2 GiB");
                    await using var input = File.OpenRead(destination);
                    var hash = Convert.ToHexString(await SHA256.HashDataAsync(input)).ToLowerInvariant();
                    var item = new OutgoingFile(id, name, destination, size, hash);
                    Save(queueFile, queue.Append(item).ToList());
                    queue.Add(item);
                }
                catch { File.Delete(destination); throw; }
            }
        }
        finally { uploads.Release(); Report(); }
        await SendQueue();
    }

    internal static void Stage(string source, string destination, bool folder)
    {
        const long limit = 512L * 1024 * 1024;
        if ((File.GetAttributes(source) & FileAttributes.ReparsePoint) != 0) throw new IOException("请直接选择原文件，不支持符号链接或联接目录");
        if (!folder)
        {
            if (new FileInfo(source).Length > limit) throw new IOException("单文件超过 512 MiB");
            File.Copy(source, destination, false);
            return;
        }
        using var archive = ZipFile.Open(destination, ZipArchiveMode.Create);
        long size = 0;
        var count = 0;
        var directories = new Stack<string>();
        directories.Push(source);
        while (directories.TryPop(out var current))
        {
            foreach (var entry in Directory.EnumerateFileSystemEntries(current))
            {
                if (++count > 10000) throw new IOException("文件夹项目超过 10000 个，请先手动打包");
                var attr = File.GetAttributes(entry);
                if ((attr & FileAttributes.ReparsePoint) != 0) throw new IOException("文件夹包含符号链接或联接目录，请先移除链接再打包");
                var relative = Path.GetRelativePath(source, entry).Replace('\\', '/');
                if ((attr & FileAttributes.Directory) != 0) { archive.CreateEntry(relative + "/"); directories.Push(entry); }
                else
                {
                    size += new FileInfo(entry).Length;
                    if (size > limit) throw new IOException("文件夹原始内容超过 512 MiB，请拆分发送");
                    archive.CreateEntryFromFile(entry, relative, CompressionLevel.Fastest);
                }
            }
        }
    }

    internal async Task SendQueue()
    {
        if (!await uploads.WaitAsync(0)) return;
        try
        {
            while (queue.FirstOrDefault() is { } file)
            {
                await using var input = File.OpenRead(file.Path);
                if (input.Length != file.Size || Convert.ToHexString(await SHA256.HashDataAsync(input)).ToLowerInvariant() != file.Hash)
                    throw new IOException("待发副本已改变，请保留队列并重新检查文件");
                var transfer = await Post("api/transfers", new { id = file.Id, name = file.Name, size = file.Size });
                var offset = transfer["offset"]!.GetValue<long>();
                var chunkSize = Math.Clamp(transfer["chunkSize"]!.GetValue<int>(), 1, 4 * 1024 * 1024);
                var buffer = new byte[chunkSize];
                input.Position = offset;
                while (offset < file.Size)
                {
                    int length = await input.ReadAsync(buffer.AsMemory(0, (int)Math.Min(chunkSize, file.Size - offset)));
                    if (length == 0) throw new IOException("待发文件提前结束");
                    using var content = new ByteArrayContent(buffer, 0, length);
                    var reply = await ReadResponse(await Http.PutAsync($"api/transfers/{file.Id}?offset={offset}", content));
                    var next = reply["offset"]!.GetValue<long>();
                    if (next != offset + length) throw new IOException("服务返回的传输位置不正确");
                    offset = next;
                    Changed?.Invoke(new { type = "upload", name = file.Name, progress = (int)(100 * offset / Math.Max(1, file.Size)) });
                }
                var result = await Post($"api/transfers/{file.Id}/complete");
                if (result["item"]?["sha256"]?.ToString() != file.Hash) throw new IOException("收件校验不一致，请保留文件并检查服务");
                Save(queueFile, queue.Skip(1).ToList());
                queue.RemoveAt(0);
                await input.DisposeAsync();
                File.Delete(file.Path);
                Changed?.Invoke(new { type = "queued", name = file.Name });
            }
        }
        finally { uploads.Release(); Report(); }
    }
    public void Dispose() => Http.Dispose();
}
