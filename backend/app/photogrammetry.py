"""Phase 2 seam: photogrammetry refinement (not implemented).

The intended design, so the rest of the app does not need to change when
this lands:

1. A photo set is uploaded against an area id and queued as a job.
2. A worker runs structure-from-motion (COLMAP or OpenSfM) to produce a
   sparse/dense point cloud in an arbitrary local frame.
3. The cloud is registered to the 3DEP DEM (ICP against the heightfield,
   seeded by EXIF GPS when present) to get it into the area's frame.
4. Registered depth is fused into the heightfield where photo coverage is
   dense, producing a "refined" heights layer served alongside the original.

The frontend already treats heights as a fetched artifact keyed by area id,
so a refined DEM is just another endpoint. Until then this module only
documents the seam.
"""


def refine(area_id: str) -> None:
    raise NotImplementedError(
        "Photogrammetry refinement is a planned phase 2 feature. "
        "See backend/app/photogrammetry.py for the design."
    )
