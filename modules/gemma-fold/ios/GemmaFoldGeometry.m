#import "GemmaFoldGeometry.h"

CGRect GemmaActiveDivisionFrame(UIView *view) {
// Older SDKs can still build the app with window resizing and safe areas.
#if __IPHONE_OS_VERSION_MAX_ALLOWED >= 270100
    if (@available(iOS 27.1, *)) {
        UIViewReservedRegion *division =
            [view reservedRegionsOfKind:[UIViewReservedRegionKind divisionRegionKind] options:0].firstObject;
        if (division != nil) {
            return division.frame;
        }
    }
#endif
    return CGRectNull;
}
