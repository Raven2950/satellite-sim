export class ViewControls {
  constructor(cameraController, { onChange }) {
    this.cameraController = cameraController;
    this.onChange = onChange;

    this.btnRegional = document.getElementById('btnViewRegional');
    this.btnGlobal = document.getElementById('btnViewGlobal');

    this.btnRegional.addEventListener('click', () => {
      this.cameraController.switchMode('regional');
      this.refresh();
      this.onChange?.();
    });

    this.btnGlobal.addEventListener('click', () => {
      this.cameraController.switchMode('global');
      this.refresh();
      this.onChange?.();
    });

    this.refresh();
  }

  refresh() {
    const mode = this.cameraController.activeMode;
    this.btnRegional.classList.toggle('active', mode === 'regional');
    this.btnGlobal.classList.toggle('active', mode === 'global');
  }
}
