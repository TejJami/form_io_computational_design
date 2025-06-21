from django.db import models
from django.utils import timezone

class Project(models.Model):
    PROJECT_TYPES = [
        ('residential', 'Residential Project'),
        ('acoustic', 'Acoustic Project'),
        ('urban', 'Urban Planning Project'),
    ]

    name = models.CharField(max_length=255, unique=True)
    type = models.CharField(max_length=50, choices=PROJECT_TYPES, default='residential')
    site_bounds  = models.JSONField(default=dict, blank=True) 
    site_envelope = models.JSONField(default=dict, blank=True) 
    blocks_envelope = models.JSONField(default=dict, blank=True)

    map_style = models.CharField(max_length=100, default='mapbox/light-v11')
    inputs = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        return self.name