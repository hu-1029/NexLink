# Third-Party Notices

NexLink bundles or interacts with the following third-party open-source components and data:

1. **Mihomo (Clash Meta)**
   - Repository: https://github.com/MetaCubeX/mihomo
   - License: GNU General Public License v3.0 (GPL-3.0)
   - Usage: Proxy core binary (`resources/mihomo/mihomo.exe`). Note: `mihomo.exe` is excluded from Git source tracking (`.gitignore`) and is fetched from official GitHub Releases during build packaging or runtime core updates.

2. **Wintun**
   - Website: https://www.wintun.net/
   - License: Wintun Prebuilt Binaries License (https://www.wintun.net/ ; prebuilt signed driver binary `resources/mihomo/wintun.dll` permitted for redistribution with software using its API; Wintun driver source code is licensed under GPL-2.0)
   - Usage: Prebuilt signed Windows TUN driver (`resources/mihomo/wintun.dll`)

3. **MaxMind GeoLite2 / MetaCubeX meta-rules-dat**
   - Website / Repository: https://www.maxmind.com / https://github.com/MetaCubeX/meta-rules-dat
   - License: Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0) / GPL-3.0
   - Attribution: This product includes GeoLite2 data created by MaxMind, available from https://www.maxmind.com.
   - Usage: GeoIP / GeoSite routing database (`resources/rules/geoip.metadb`, and runtime-synced `.mmdb` / `.dat` databases)
