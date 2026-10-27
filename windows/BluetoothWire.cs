namespace NearBridge;

internal static class BluetoothWire
{
    internal static bool ValidWrite(byte[] bytes, uint offset = 0) => offset == 0 && bytes.Length is >= 2 and <= 512 && bytes[1] != 0 &&
        (bytes[0] is 1 or 4 ? bytes.Length == 2 : bytes[0] == 3 && bytes.Length > 2);

    internal static IEnumerable<byte[]> Frames(byte type, byte id, byte[] payload, int limit)
    {
        if (id == 0 || limit < 3 || type is < 1 or > 4 || (type != 3 && payload.Length != 0) || (type == 3 && payload.Length == 0))
            throw new ArgumentException("BLE 帧无效");
        var size = Math.Min(512, limit) - 2;
        if (payload.Length == 0) { yield return [type, id]; yield break; }
        for (int start = 0; start < payload.Length; start += size)
        {
            int length = Math.Min(size, payload.Length - start);
            var frame = new byte[length + 2]; frame[0] = type; frame[1] = id;
            Array.Copy(payload, start, frame, 2, length);
            yield return frame;
        }
    }
}
