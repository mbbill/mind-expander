pub struct Gauge {
    pub reading: u32,
}

impl Gauge {
    /// A method. Cmd/Ctrl+click on its diagram row opens the code panel
    /// scrolled to these lines.
    pub fn read(&self) -> u32 {
        self.reading
    }
}
