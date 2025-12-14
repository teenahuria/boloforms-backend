
function toPdfPoints({ 
    x: relativeX, 
    y: relativeY, 
    width: relativeWidth, 
    height: relativeHeight 
}, pdfPageWidth, pdfPageHeight) {

    
    const absoluteX = relativeX * pdfPageWidth;
    const absoluteWidth = relativeWidth * pdfPageWidth;
    const absoluteHeight = relativeHeight * pdfPageHeight;
    const absoluteY_TopLeft = relativeY * pdfPageHeight;
    
    
    const pdfY_BottomLeft = pdfPageHeight - (absoluteY_TopLeft + absoluteHeight);
    
    return {
        x: absoluteX,
        y: pdfY_BottomLeft, 
        width: absoluteWidth,
        height: absoluteHeight,
    };
}

module.exports = { toPdfPoints };