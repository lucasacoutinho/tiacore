document.querySelector('#shared').textContent = 'shared ready'
document.querySelector('#load').addEventListener('click', async () => {
  await import('./lazy.js')
})
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbInNoYXJlZC5qcyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiIn0=
