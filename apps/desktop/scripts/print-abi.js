console.log(
  JSON.stringify({
    modules: process.versions.modules,
    electron: process.versions.electron,
    node: process.versions.node,
  }),
);
setTimeout(() => process.exit(0), 100);
