const { withDangerousMod } = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');

/**
 * Expo config plugin that patches the fmt library's base.h to disable consteval,
 * working around a compilation error with Xcode 16+ / newer Apple Clang.
 */
function withFixFmtConsteval(config) {
  return withDangerousMod(config, [
    'ios',
    async (config) => {
      const podfile = path.join(config.modRequest.platformProjectRoot, 'Podfile');

      if (fs.existsSync(podfile)) {
        let content = fs.readFileSync(podfile, 'utf8');

        if (!content.includes('PATCHED: fix fmt consteval')) {
          // Insert the fmt patch into the post_install block
          const patchCode = `
    # PATCHED: fix fmt consteval for Xcode 16+ compatibility
    fmt_base_path = File.join(__dir__, 'Pods', 'fmt', 'include', 'fmt', 'base.h')
    if File.exist?(fmt_base_path)
      fmt_content = File.read(fmt_base_path)
      unless fmt_content.include?('PATCHED: Force disable consteval')
        fmt_content.gsub!(
          /\\/\\/ Detect consteval.*?^#define FMT_CONSTEXPR20.*$\\n/m,
          "// Detect consteval, C++20 constexpr extensions and std::is_constant_evaluated.\\n// PATCHED: Force disable consteval for Xcode 16+ Apple Clang compatibility\\n#define FMT_USE_CONSTEVAL 0\\n#define FMT_CONSTEVAL\\n#define FMT_CONSTEXPR20\\n"
        )
        File.write(fmt_base_path, fmt_content)
      end
    end
`;
          // Insert before the closing 'end' of post_install
          content = content.replace(
            /(post_install do \|installer\|.*?react_native_post_install\([^)]*\))/s,
            `$1\n${patchCode}`
          );

          fs.writeFileSync(podfile, content);
        }
      }

      return config;
    },
  ]);
}

module.exports = withFixFmtConsteval;
