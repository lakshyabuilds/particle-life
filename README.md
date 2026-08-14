# particle life

I have created this particle life simulator that runs in your browser.

## what it is

In this game/simulator, every pixel is a particle, one of the seven colors. The small grid in the corner is the rule table: row pulls or shun column. You can paint the grid with the mouse to reqire the rules while it runs. The diagonal stays negative so a color spreads itself out instead of piling into a blob, and the off-diagonal is a chase ring, so it necer quite settles.

## controls

- click: drop some random pixels or random colors
- hold left: gather multiple characters
- hold right: blast some particles that are stucking together
- wheel or pinch: you can zoom in or zoom out to insoect some particles.
- double-click: reset the view.
- r: new rules, new life.
- n: reset the soup.
- h: hide the panel.

## what makes it tick

The simulator uses rules based emergent complexity. Each particle follows some behaviour to another particle. Some repel, some attract, and even more complex behaviors, and this alone create beautiful representation of how our nature also may work. Chaos how creates pattern if left alone and how sometimes control can become chaos if interferred.
