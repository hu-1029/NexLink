import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { verifyWindowsPathAclChainSync } from '../../src/main/network/service-manager';

describe('Windows 真实 ACL 链校验专项测试 (不注入任何假结果/Mock)', () => {
  it('真实 NTFS 目录 ACL 检查：Users 仅有 ReadAndExecute 应判定为安全，Users 有 Modify 或 WriteData 应判定为不安全', () => {
    if (process.platform !== 'win32') {
      return;
    }

    // 在标准受保护的 Program Files 根下建立测试目录与文件，父链（Program Files）在标准 Windows 上默认安全
    const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
    const testDir = path.join(programFiles, `NexLink_Acl_Test_${Date.now()}`);
    const testFile = path.join(testDir, 'mihomo.exe');

    try {
      fs.mkdirSync(testDir, { recursive: true });
      fs.writeFileSync(testFile, 'MZ_DUMMY_BINARY_DATA');

      // 阶段 1：严格配置为 Users 仅有 ReadAndExecute（RX），拒绝任何继承与额外写权限
      // 同时验证 InheritOnly 规则（如容器或目录上针对将来子项的规则）不应误杀当前对象
      execFileSync('icacls.exe', [
        testDir,
        '/inheritance:r',
        '/grant',
        'SYSTEM:(OI)(CI)F',
        '/grant',
        'Administrators:(OI)(CI)F',
        '/grant',
        'Users:(OI)(CI)RX',
        '/Q',
      ]);
      execFileSync('icacls.exe', [
        testFile,
        '/inheritance:r',
        '/grant',
        'SYSTEM:F',
        '/grant',
        'Administrators:F',
        '/grant',
        'Users:RX',
        '/Q',
      ]);

      const safeResult = verifyWindowsPathAclChainSync(testFile);
      assert.equal(
        safeResult.locked,
        true,
        `Users 仅有 ReadAndExecute 时应判定为安全锁定，实际结果: ${JSON.stringify(safeResult)}`
      );

      // 阶段 2：向 Users 授予 WriteData (WD) 写入类权限 -> 必须立刻判定为不安全
      execFileSync('icacls.exe', [testFile, '/grant', 'Users:(WD)', '/Q']);
      const unsafeWriteDataResult = verifyWindowsPathAclChainSync(testFile);
      assert.equal(
        unsafeWriteDataResult.locked,
        false,
        'Users 拥有 WriteData 写入权限时必须判定为不安全 (locked=false)'
      );
      assert.equal(
        unsafeWriteDataResult.unsafeSid,
        'S-1-5-32-545',
        '不安全的 SID 必须精准识别为 BUILTIN\\Users (S-1-5-32-545)'
      );

      // 阶段 3：移除后向 Users 授予 Modify (M) 复合修改权限 -> 必须立刻判定为不安全
      execFileSync('icacls.exe', [testFile, '/remove', 'Users', '/Q']);
      execFileSync('icacls.exe', [testFile, '/grant', 'Users:(M)', '/Q']);
      const unsafeModifyResult = verifyWindowsPathAclChainSync(testFile);
      assert.equal(
        unsafeModifyResult.locked,
        false,
        'Users 拥有 Modify 修改权限时必须判定为不安全 (locked=false)'
      );
      assert.equal(
        unsafeModifyResult.unsafeSid,
        'S-1-5-32-545',
        '不安全的 SID 必须精准识别为 BUILTIN\\Users (S-1-5-32-545)'
      );

      // 阶段 4 (P0-1)：即使 DACL 仅允许 Users RX，只要 NTFS Owner 为非特权 SID (Users)，仍必须判定为不安全！
      execFileSync('icacls.exe', [testFile, '/remove', 'Users', '/Q']);
      execFileSync('icacls.exe', [testFile, '/grant', 'Users:RX', '/Q']);
      execFileSync('icacls.exe', [testFile, '/setowner', 'Users', '/Q']);
      const unsafeOwnerResult = verifyWindowsPathAclChainSync(testFile);
      assert.equal(
        unsafeOwnerResult.locked,
        false,
        `NTFS Owner 为普通用户 (Users) 时即使 DACL 锁定也必须判定为不安全，实际结果: ${JSON.stringify(unsafeOwnerResult)}`
      );
      assert.equal(
        unsafeOwnerResult.unsafeSid,
        'S-1-5-32-545',
        '不安全 Owner SID 必须识别为 S-1-5-32-545'
      );
    } finally {
      if (fs.existsSync(testDir)) {
        try {
          fs.rmSync(testDir, { recursive: true, force: true });
        } catch {
          // ignore
        }
      }
    }
  });
});
