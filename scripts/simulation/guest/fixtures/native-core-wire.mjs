// Independent Linux/x86-64 core wire fixture. These buffers are ET_CORE data,
// never host-executable programs; offsets deliberately assert the kernel ABI.
export function nativeCoreWireFixture({
    pid = 404,
    tid = pid,
    includeCode = false,
} = {}) {
    const filename = "/workbench/output/native-probe/null-write";
    const rip = 0x40007an,
        rsp = 0x70000100n;
    const note = (type, data) => {
        const bytes = Buffer.alloc(20 + Math.ceil(data.length / 4) * 4);
        bytes.writeUInt32LE(5, 0);
        bytes.writeUInt32LE(data.length, 4);
        bytes.writeUInt32LE(type, 8);
        Buffer.from("CORE\0").copy(bytes, 12);
        data.copy(bytes, 20);
        return bytes;
    };
    const status = Buffer.alloc(336),
        info = Buffer.alloc(136),
        signal = Buffer.alloc(128);
    status.writeInt16LE(11, 12);
    status.writeInt32LE(tid, 32);
    status.writeBigUInt64LE(rip, 240);
    status.writeBigUInt64LE(rsp, 264);
    info.writeInt32LE(pid, 24);
    Buffer.from("null-write").copy(info, 40);
    signal.writeInt32LE(11, 0);
    signal.writeInt32LE(1, 8);
    const name = Buffer.from(`${filename}\0`),
        file = Buffer.alloc(40 + name.length);
    file.writeBigUInt64LE(1n, 0);
    file.writeBigUInt64LE(4096n, 8);
    file.writeBigUInt64LE(0x400000n, 16);
    file.writeBigUInt64LE(0x401000n, 24);
    name.copy(file, 40);
    const notes = Buffer.concat([
        note(1, status),
        note(3, info),
        note(0x53494749, signal),
        note(0x46494c45, file),
    ]);
    const code = Buffer.alloc(4096, 0x90),
        stack = Buffer.alloc(131072);
    code.set([0x89, 0, 0x0f, 0x0b], 122);
    stack.writeBigUInt64LE(0x400110n, 256);
    stack.writeBigUInt64LE(0x415254474f444b41n, 264);
    const dataOffset = 64 + 3 * 56,
        codeOffset = dataOffset + notes.length;
    const raw = Buffer.alloc(codeOffset + (includeCode ? code.length : 0));
    Buffer.from("7f454c4602010100", "hex").copy(raw);
    raw.writeUInt16LE(4, 16);
    raw.writeUInt16LE(62, 18);
    raw.writeUInt32LE(1, 20);
    raw.writeBigUInt64LE(64n, 32);
    raw.writeUInt16LE(64, 52);
    raw.writeUInt16LE(56, 54);
    raw.writeUInt16LE(3, 56);
    raw.writeUInt32LE(4, 64);
    raw.writeBigUInt64LE(BigInt(dataOffset), 72);
    raw.writeBigUInt64LE(BigInt(notes.length), 96);
    for (const [index, address, size, flags] of [
        [1, 0x400000n, 4096n, 5],
        [2, 0x70000000n, 131072n, 6],
    ]) {
        const at = 64 + index * 56;
        raw.writeUInt32LE(1, at);
        raw.writeUInt32LE(flags, at + 4);
        raw.writeBigUInt64LE(BigInt(codeOffset), at + 8);
        raw.writeBigUInt64LE(address, at + 16);
        raw.writeBigUInt64LE(size, at + 40);
        raw.writeBigUInt64LE(4096n, at + 48);
        if (index === 1 && includeCode) {
            raw.writeBigUInt64LE(BigInt(code.length), at + 32);
            code.copy(raw, codeOffset);
        }
    }
    notes.copy(raw, dataOffset);
    return {
        raw,
        notes,
        pid,
        tid,
        rip,
        rsp,
        filename,
        code,
        stack,
        maps: `00400000-00401000 r-xp 00000000 00:01 1 ${filename}\n70000000-70020000 rw-p 00000000 00:00 0 [stack]\n`,
    };
}
