/* Auto-loader for bypass-napi native addon */
const { platform, arch } = process;

let suffix;
if (platform === 'win32') {
  suffix = `${platform}-${arch}-msvc`;
} else if (platform === 'darwin') {
  suffix = `${platform}-${arch}`;
} else {
  // linux (glibc)
  suffix = `${platform}-${arch}-gnu`;
}

const nativeBinding = require(`./bypass-napi.${suffix}.node`);

module.exports = nativeBinding;
