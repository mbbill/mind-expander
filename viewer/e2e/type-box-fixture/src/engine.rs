pub struct Engine {
    pub power: u32,
    pub torque: u32,
}

impl Engine {
    /// Two-argument method. Clicking the method row name in the diagram
    /// expands its signature into one argument row per parameter.
    pub fn set_power(&mut self, watts: u32, rpm: u32) {
        self.power = watts;
        self.torque = rpm;
    }

    pub fn power(&self) -> u32 {
        self.power
    }
}
