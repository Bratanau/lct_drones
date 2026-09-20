(() => {
  async function request(url, options = {}) {
    const response = await window.fetch(url, options);
    return response;
  }

  window.Api = { request };
})();
