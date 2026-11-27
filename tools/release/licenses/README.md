The pi-ai npm archive omits its license file. `pi-ai-1.6.0.LICENSE` is copied from the [upstream v1.6.0 license](https://github.com/earendil-works/pi/blob/v1.6.0/LICENSE).

The CLI build reads Bun's module graph and includes the license notices for each bundled dependency. Other notices come directly from the installed dependency archives. A dependency without an available notice fails the build.
