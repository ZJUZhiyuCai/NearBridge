using System.Net.Sockets;
using Windows.Devices.Bluetooth;
using Windows.Devices.Bluetooth.GenericAttributeProfile;
using Windows.Storage.Streams;

namespace NearBridge;

// Same UUIDs/framing as HarmonyOS and macOS. Only the authenticated phone TLS
// listener is reachable; the relay never proxies the desktop admin endpoint.
internal sealed class BluetoothBridge : IAsyncDisposable
{
    internal static readonly Guid ServiceId = new("b4525100-17b0-4cb4-96a6-06c73a620c31");
    readonly int port;
    readonly SemaphoreSlim gate = new(1, 1);
    readonly SemaphoreSlim transmit = new(1, 1);
    readonly Dictionary<byte, Pipe> pipes = [];
    GattServiceProvider? provider;
    GattLocalCharacteristic? rx, tx;
    GattSubscribedClient? peer;
    long generation;
    bool enabled;
    long received, sent;
    internal event Action<string, bool>? Status;

    internal BluetoothBridge(int nativePort) { port = nativePort; }
    internal async Task Start()
    {
        if (enabled) return;
        var epoch = ++generation;
        var adapter = await BluetoothAdapter.GetDefaultAsync();
        if (epoch != generation) return;
        if (adapter == null || !adapter.IsPeripheralRoleSupported)
            throw new InvalidOperationException("这台电脑的蓝牙适配器/驱动不支持 BLE 外围设备模式，可继续使用局域网。");
        var result = await GattServiceProvider.CreateAsync(ServiceId);
        if (epoch != generation) return;
        if (result.Error != BluetoothError.Success) throw new IOException("Windows 蓝牙服务无法创建：" + result.Error);
        provider = result.ServiceProvider;
        var receive = await provider.Service.CreateCharacteristicAsync(new Guid("b4525101-17b0-4cb4-96a6-06c73a620c31"), new GattLocalCharacteristicParameters {
            CharacteristicProperties = GattCharacteristicProperties.Write,
            WriteProtectionLevel = GattProtectionLevel.Plain
        });
        if (epoch != generation) return;
        var send = await provider.Service.CreateCharacteristicAsync(new Guid("b4525102-17b0-4cb4-96a6-06c73a620c31"), new GattLocalCharacteristicParameters {
            CharacteristicProperties = GattCharacteristicProperties.Indicate,
            ReadProtectionLevel = GattProtectionLevel.Plain
        });
        if (epoch != generation) return;
        if (receive.Error != BluetoothError.Success || send.Error != BluetoothError.Success) { await Stop(); throw new IOException("Windows 无法创建蓝牙收发特征"); }
        rx = receive.Characteristic; tx = send.Characteristic;
        rx.WriteRequested += OnWrite;
        tx.SubscribedClientsChanged += OnSubscribers;
        provider.AdvertisementStatusChanged += OnAdvertisement;
        enabled = true;
        Status?.Invoke("正在启动 Windows 蓝牙广播…", true);
        provider.StartAdvertising(new GattServiceProviderAdvertisingParameters { IsConnectable = true, IsDiscoverable = true });
    }

    async void OnAdvertisement(GattServiceProvider sender, GattServiceProviderAdvertisementStatusChangedEventArgs args)
    {
        if (sender != provider || !enabled) return;
        if (args.Status == GattServiceProviderAdvertisementStatus.Started) Status?.Invoke("蓝牙已就绪 · 等待手机连接", true);
        else if (args.Status == GattServiceProviderAdvertisementStatus.Aborted) { await Stop(); Status?.Invoke("Windows 蓝牙广播失败：" + args.Error + "，请检查蓝牙开关和驱动", false); }
    }

    async void OnSubscribers(GattLocalCharacteristic sender, object args)
    {
        await gate.WaitAsync();
        try
        {
            if (!enabled || sender != tx) return;
            if (peer != null && sender.SubscribedClients.Any(client => client.Session.DeviceId.Id == peer.Session.DeviceId.Id)) return;
            ResetLink();
            peer = sender.SubscribedClients.FirstOrDefault();
            Status?.Invoke(peer == null ? "蓝牙已就绪 · 等待手机连接" : "蓝牙已连接 · 正在验证设备", true);
        }
        catch (Exception error) { Status?.Invoke("蓝牙订阅失败：" + error.Message, enabled); }
        finally { gate.Release(); }
    }

    async void OnWrite(GattLocalCharacteristic sender, GattWriteRequestedEventArgs args)
    {
        var deferral = args.GetDeferral();
        GattWriteRequest? request = null;
        var responded = false;
        await gate.WaitAsync();
        try
        {
            request = await args.GetRequestAsync();
            if (request == null) return;
            using var reader = DataReader.FromBuffer(request.Value);
            var bytes = new byte[reader.UnconsumedBufferLength]; reader.ReadBytes(bytes);
            if (!enabled || sender != rx || peer == null || args.Session.DeviceId.Id != peer.Session.DeviceId.Id ||
                request.Option != GattWriteOption.WriteWithResponse || !BluetoothWire.ValidWrite(bytes, request.Offset))
            { request.RespondWithProtocolError(0x06); responded = true; return; }
            var id = bytes[1];
            if (bytes[0] == 1)
            {
                if (pipes.TryGetValue(id, out var duplicate)) { ClosePipe(id, duplicate); await Send(4, id, [], generation); }
                else if (pipes.Count >= 4) await Send(4, id, [], generation);
                else
                {
                    var pipe = new Pipe(); pipes.Add(id, pipe);
                    // Respond before connecting; Opened is sent only after TCP is ready.
                    request.Respond(); responded = true;
                    _ = OpenPipe(id, pipe, generation);
                }
            }
            else if (bytes[0] == 3)
            {
                if (pipes.TryGetValue(id, out var pipe) && pipe.Ready)
                {
                    using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(8));
                    await pipe.Socket.GetStream().WriteAsync(bytes.AsMemory(2), timeout.Token);
                    pipe.Touch(); received += bytes.Length - 2;
                }
                else await Send(4, id, [], generation);
            }
            else if (pipes.TryGetValue(id, out var closed)) ClosePipe(id, closed);
            if (!responded) { request.Respond(); responded = true; }
        }
        catch (Exception error)
        {
            if (!responded) { try { request?.RespondWithProtocolError(0x0E); } catch { } }
            ResetLink(); Status?.Invoke("蓝牙连接已中断：" + error.Message, enabled);
        }
        finally { gate.Release(); deferral.Complete(); }
    }

    async Task OpenPipe(byte id, Pipe pipe, long epoch)
    {
        try
        {
            using var connect = new CancellationTokenSource(TimeSpan.FromSeconds(8));
            await pipe.Socket.ConnectAsync("127.0.0.1", port, connect.Token);
            await gate.WaitAsync();
            try
            {
                if (!enabled || epoch != generation || !pipes.TryGetValue(id, out var current) || current != pipe) return;
                pipe.Ready = true;
            }
            finally { gate.Release(); }
            if (!await Send(2, id, [], epoch)) return;
            var buffer = new byte[4096];
            while (enabled && epoch == generation && !pipe.Closed)
            {
                int length = await pipe.Socket.GetStream().ReadAsync(buffer, pipe.Idle.Token);
                if (length == 0 || !await Send(3, id, buffer[..length], epoch)) break;
                pipe.Touch();
            }
        }
        catch (Exception) { /* A lost BLE/TCP link closes this stream; phone owns retries. */ }
        finally
        {
            await gate.WaitAsync();
            try { if (pipes.TryGetValue(id, out var current) && current == pipe) { ClosePipe(id, pipe); await Send(4, id, [], epoch); } }
            finally { gate.Release(); pipe.Dispose(); }
        }
    }

    async Task<bool> Send(byte type, byte id, byte[] payload, long epoch)
    {
        // One read per stream, <=4 streams, <=4096 bytes pending per stream.
        // Await each indication for backpressure; no unbounded notification queue.
        await transmit.WaitAsync();
        try
        {
            var target = peer; var characteristic = tx;
            if (!enabled || epoch != generation || target == null || characteristic == null) return false;
            foreach (var frame in BluetoothWire.Frames(type, id, payload, target.MaxNotificationSize))
            {
                if (epoch != generation || peer != target) return false;
                using var writer = new DataWriter(); writer.WriteBytes(frame);
                using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(15));
                var result = await characteristic.NotifyValueAsync(writer.DetachBuffer(), target).AsTask(timeout.Token);
                if (result.Status != GattCommunicationStatus.Success) return false;
            }
            if (type == 3) sent += payload.Length;
            Status?.Invoke($"蓝牙直传 · 已收 {received / 1024} KB · 已发 {sent / 1024} KB", true);
            return true;
        }
        finally { transmit.Release(); }
    }
    void ClosePipe(byte id, Pipe pipe) { pipes.Remove(id); pipe.Dispose(); }
    void ResetLink()
    {
        generation++; peer = null;
        foreach (var pipe in pipes.Values) pipe.Dispose();
        pipes.Clear();
    }
    internal async Task Stop()
    {
        enabled = false;
        try { provider?.StopAdvertising(); } catch { /* Radio removal must still release pipes and handlers. */ }
        if (provider != null) provider.AdvertisementStatusChanged -= OnAdvertisement;
        if (rx != null) rx.WriteRequested -= OnWrite;
        if (tx != null) tx.SubscribedClientsChanged -= OnSubscribers;
        // Never block the UI thread while an in-flight WinRT event awaits it.
        await gate.WaitAsync();
        try { ResetLink(); rx = null; tx = null; provider = null; }
        finally { gate.Release(); }
        Status?.Invoke("蓝牙未开启", false);
    }
    public ValueTask DisposeAsync() => new(Stop());
    sealed class Pipe : IDisposable
    {
        internal readonly TcpClient Socket = new();
        internal readonly CancellationTokenSource Idle = new(TimeSpan.FromSeconds(120));
        internal bool Ready, Closed;
        internal void Touch() { if (!Closed) Idle.CancelAfter(TimeSpan.FromSeconds(120)); }
        public void Dispose() { if (Closed) return; Closed = true; Idle.Cancel(); Socket.Dispose(); }
    }
}
