# Fit at phone widths, on the final build (index-BQUOaQ4A.css), 23 Nov

A one-off scan with a scratch script (not in the repository): each page title, lead figure, card title and pay line on 13 screens at 320, 360 and 390 px, flagged when its text runs past its own box, past the nearest ancestor that clips, or past the window, and the page when it scrolls sideways. Then a bill's amount on Spend (chosen bill ₹6,120.00), whose text should end inside its box.

```
PAST  320 /            p.pos-figure                       44px     own+14 clip+0 win+0  "₹7,00,278.39"
1 problems

320 {"size":"30px","text":"₹6,120.00","textRight":209,"boxRight":264,"clipRight":304,"page":0}
360 {"size":"30px","text":"₹6,120.00","textRight":209,"boxRight":304,"clipRight":344,"page":0}
390 {"size":"30px","text":"₹6,120.00","textRight":209,"boxRight":334,"clipRight":374,"page":0}
1440 {"size":"44px","text":"₹6,120.00","textRight":921,"boxRight":1332,"clipRight":1392,"page":0}
```

Home's position figure at 320 px runs 14 px past its own box into the field's padding; it is not clipped and the page does not scroll sideways. It was 44 px on a phone before this pass as well.
