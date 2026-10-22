/*
 * File saving: downloads.save({ filename, data }) where data is a string or Blob.
 * Works in browsers and the Windows desktop shell. The Android build (step 3) swaps in a
 * native share/save sheet here.
 */
(() => {
  const browserDownloads = {
    async save({ filename, data }) {
      const blob = data instanceof Blob ? data : new Blob([data], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob), a = document.createElement("a");
      a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      return { status: "saved" };
    },
  };
  window.RMP = { ...(window.RMP || {}), downloads: browserDownloads };
})();
